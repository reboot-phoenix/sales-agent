"""College discovery source adapters.

Sources are intentionally diverse so no single portal is a point of failure:

  * AISHE       — the government institution registry (CSV export)
  * UGC         — recognised universities page (HTML tables)
  * NIRF        — rankings pages (HTML tables), gives rank + location
  * state portals — configured per state (HTML tables / CSV)
  * official college sites — structured data (JSON-LD) + contact/placement pages

Only publicly downloadable/visible data is read. Where a source requires an
operator-supplied export URL (AISHE data downloads are published as files, not a
stable query API), the adapter reads it from configuration and reports itself
unavailable — never silently returns invented rows — when that is absent.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
from typing import Any, Optional

from ..base import RawDiscovery, SourceAdapter, SourceTemporarilyUnavailable
from ..hackathons.adapters import extract_json_ld
from ..normalize import as_list, clean_text, extract_domain, parse_bool

try:  # beautifulsoup4 is already a project dependency
    from bs4 import BeautifulSoup
    _HAVE_BS4 = True
except Exception:  # noqa: BLE001
    _HAVE_BS4 = False

# Header keyword -> canonical column. Order matters: the first match wins, so
# more specific phrases are listed before generic ones.
_COLUMN_HINTS: tuple[tuple[str, str], ...] = (
    ("aishe", "aishe_code"),
    ("a_i_s_h_e", "aishe_code"),
    ("institution name", "name"),
    ("university name", "name"),
    ("institute name", "name"),
    ("college name", "name"),
    ("name of", "name"),
    ("institution", "name"),
    ("university", "university_affiliation"),
    ("affiliat", "university_affiliation"),
    ("district", "district"),
    ("city", "city"),
    ("state", "state"),
    ("website", "website_url"),
    ("url", "website_url"),
    ("email", "official_email"),
    ("phone", "phone"),
    ("contact", "phone"),
    ("pincode", "pincode"),
    ("pin code", "pincode"),
    ("type", "institution_type"),
    ("owner", "ownership"),
    ("management", "ownership"),
    ("rank", "nirf_rank"),
    ("grade", "naac_grade"),
    ("cgpa", "naac_grade"),
    ("name", "name"),
)


def canonical_header(header: str) -> Optional[str]:
    key = re.sub(r"[^a-z0-9 ]", " ", clean_text(header).lower())
    for hint, column in _COLUMN_HINTS:
        if hint in key:
            return column
    return None


def parse_html_tables(html: str, source_url: str, default_state: Optional[str] = None) -> list[dict]:
    """Extract institution rows from any HTML table on a page.

    Generic by design: government portals reshape their markup every few years,
    so the adapter identifies columns from header text rather than DOM positions.
    """
    if not _HAVE_BS4:
        raise SourceTemporarilyUnavailable("beautifulsoup4 not installed")
    soup = BeautifulSoup(html or "", "lxml")
    rows_out: list[dict] = []
    for table in soup.find_all("table"):
        header_cells = [th.get_text(" ", strip=True) for th in table.find_all("th")]
        if not header_cells:
            first_row = table.find("tr")
            if first_row:
                header_cells = [td.get_text(" ", strip=True) for td in first_row.find_all("td")]
        mapping = {idx: col for idx, header in enumerate(header_cells)
                   if (col := canonical_header(header))}
        if "name" not in mapping.values():
            continue
        for tr in table.find_all("tr"):
            cells = tr.find_all("td")
            if len(cells) < 2:
                continue
            record: dict[str, Any] = {}
            extras: dict[str, str] = {}
            for idx, cell in enumerate(cells):
                column = mapping.get(idx)
                text = cell.get_text(" ", strip=True)
                if not column:
                    # Keep unmapped columns as `extra_<header>` instead of
                    # discarding them: government portals reshape their tables
                    # every cycle, and a grade/accreditation value in an
                    # unfamiliar column must survive the parse. The normalizer
                    # only reads known columns, so extras are inert elsewhere.
                    header = header_cells[idx] if idx < len(header_cells) else ""
                    key = re.sub(r"[^a-z0-9]+", "_", clean_text(header).lower()).strip("_")
                    if key and text:
                        extras[f"extra_{key}"] = text[:200]
                    continue
                if not text:
                    continue
                link = cell.find("a", href=True)
                if column == "website_url" and link:
                    text = link["href"]
                elif not record.get("website_url") and link and "http" in (link.get("href") or ""):
                    # A name cell often links the official site; keep it as a source.
                    record.setdefault("links", [])
                    if link["href"] not in record["links"]:
                        record["links"].append(link["href"])
                record[column] = text
            record.update(extras)
            if record.get("name"):
                if default_state and not record.get("state"):
                    record["state"] = default_state
                record["source_url"] = source_url
                rows_out.append(record)
    return rows_out


def parse_json_ld_colleges(html: str, source_url: str) -> list[dict]:
    """Extract CollegeOrUniversity / EducationalOrganization entities."""
    out: list[dict] = []
    for block in extract_json_ld(html or ""):
        items = block if isinstance(block, list) else [block]
        for item in items:
            if not isinstance(item, dict):
                continue
            if not str(item.get("@type", "")).lower() in (
                "collegeoruniversity", "educationalorganization", "university", "school", "organization"
            ):
                continue
            name = clean_text(item.get("name"))
            if not name:
                continue
            address = item.get("address") if isinstance(item.get("address"), dict) else {}
            out.append({
                "name": name,
                "official_name": clean_text(item.get("legalName")) or name,
                "website_url": clean_text(item.get("url")),
                "official_email": clean_text(item.get("email")),
                "phone": clean_text(item.get("telephone")),
                "address": clean_text(address.get("streetAddress")),
                "city": clean_text(address.get("addressLocality")),
                "district": clean_text(address.get("addressLocality")),
                "state": clean_text(address.get("addressRegion")),
                "country": clean_text(address.get("addressCountry")),
                "pincode": clean_text(address.get("postalCode")),
                "source_url": source_url,
                "extraction_method": "json_ld",
            })
    return out


def parse_csv_colleges(text: str, source_url: str, default_state: Optional[str] = None) -> list[dict]:
    """Parse a CSV/TSV export whose headers resemble the canonical columns."""
    sample = (text or "")[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text or ""), dialect=dialect)
    if not reader.fieldnames:
        return []
    mapping = {header: canonical_header(header) for header in reader.fieldnames}
    out: list[dict] = []
    for row in reader:
        record: dict[str, Any] = {}
        for header, column in mapping.items():
            if not column:
                continue
            value = clean_text(row.get(header))
            if value:
                record[column] = value
        if record.get("name"):
            if default_state and not record.get("state"):
                record["state"] = default_state
            record["source_url"] = source_url
            out.append(record)
    return out


class AisheAdapter(SourceAdapter):
    """AISHE institution registry (operator-supplied published export)."""

    domain = "colleges"
    name = "aishe"
    display_name = "AISHE"
    tier = 1
    base_url = "https://aishe.gov.in"
    verification_note = (
        "Reads the publicly published AISHE institution export configured via "
        "AISHE_INSTITUTIONS_URL. No stable public query API exists, so the adapter "
        "reports itself unavailable rather than inventing rows when unset."
    )

    async def discover(self) -> list[RawDiscovery]:
        url = os.environ.get("AISHE_INSTITUTIONS_URL", "").strip()
        if not url:
            raise SourceTemporarilyUnavailable("AISHE_INSTITUTIONS_URL not configured")
        from ...utils.http_client import fetch
        resp = await fetch(url, timeout=120, min_engine="httpx", max_engine="curl")
        if resp.status != 200 or not resp.text:
            raise SourceTemporarilyUnavailable(f"aishe HTTP {resp.status}")
        rows = parse_csv_colleges(resp.text, url)
        return [RawDiscovery(source=self.name, payload=r, source_url=url, extraction_method="csv") for r in rows]


class UgcUniversitiesAdapter(SourceAdapter):
    """UGC list of recognised universities (public HTML tables)."""

    domain = "colleges"
    name = "ugc"
    display_name = "UGC recognised universities"
    tier = 1
    base_url = "https://www.ugc.gov.in"
    service = os.environ.get("UGC_UNIVERSITIES_URL", "https://www.ugc.gov.in/universityinformation")

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch
        resp = await fetch(self.service, timeout=60, min_engine="httpx", max_engine="playwright")
        if resp.status != 200 or not resp.text:
            raise SourceTemporarilyUnavailable(f"ugc HTTP {resp.status}")
        rows = parse_html_tables(resp.text, self.service)
        rows += parse_json_ld_colleges(resp.text, self.service)
        return [RawDiscovery(source=self.name, payload=r, source_url=self.service, extraction_method="html_table")
                for r in rows]


class NirfAdapter(SourceAdapter):
    """NIRF rankings pages (public HTML tables + rank column)."""

    domain = "colleges"
    name = "nirf"
    display_name = "NIRF Rankings"
    tier = 2
    base_url = "https://www.nirfindia.org"
    # NIRF publishes one page per category/year; the list is operator-extendable.
    default_urls = (
        "https://www.nirfindia.org/Rankings/2024/EngineeringRanking.html",
        "https://www.nirfindia.org/Rankings/2024/CollegeRanking.html",
        "https://www.nirfindia.org/Rankings/2024/UniversityRanking.html",
    )

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch
        urls = [u.strip() for u in os.environ.get("NIRF_RANKING_URLS", "").split(",") if u.strip()]
        urls = urls or list(self.default_urls)
        records: list[RawDiscovery] = []
        errors = 0
        for url in urls:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception as e:  # noqa: BLE001
                errors += 1
                continue
            if resp.status != 200 or not resp.text:
                errors += 1
                continue
            for row in parse_html_tables(resp.text, url):
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="html_table"))
        if not records and errors:
            raise SourceTemporarilyUnavailable(f"nirf: all {errors} ranking pages unavailable")
        return records


class NaacAdapter(SourceAdapter):
    """NAAC accredited-institution listings (public HTML tables).

    NAAC's public pages carry institution names, state and the accreditation
    grade/cycle — exactly the fields the college row wants for its
    ``accreditation`` / ``naac_grade`` columns. The listing URLs are
    operator-extendable via ``NAAC_LISTING_URLS`` because the portal reshuffles
    its section pages between cycles.
    """

    domain = "colleges"
    name = "naac"
    display_name = "NAAC accredited institutions"
    tier = 2
    base_url = "https://www.naac.gov.in"
    default_urls = (
        "https://www.naac.gov.in/naac-accredited-institutions",
    )

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch
        urls = [u.strip() for u in os.environ.get("NAAC_LISTING_URLS", "").split(",") if u.strip()]
        urls = urls or list(self.default_urls)
        records: list[RawDiscovery] = []
        failures = 0
        for url in urls:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001 - try the next listing
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            for row in parse_html_tables(resp.text, url):
                if not row.get("name"):
                    continue
                if not row.get("naac_grade"):
                    # Fallback for portals whose grade column has no recognisable
                    # header: a lone grade token ('A++', 'CGPA 3.42') in an
                    # extra/unmapped column is carried verbatim.
                    for column, value in row.items():
                        if column in ("name", "state", "city", "district", "website_url",
                                      "source_url", "links"):
                            continue
                        lowered = str(value).lower()
                        if re.fullmatch(r"a\+\+|a\+|a|b\+\+|b\+|b|c|d", lowered) or "cgpa" in lowered:
                            row["naac_grade"] = str(value)
                            break
                row.setdefault("source_url", url)
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="html_table"))
        if not records and failures:
            raise SourceTemporarilyUnavailable(f"naac: all {failures} listing pages unavailable")
        return records


class JoSaaInstitutesAdapter(SourceAdapter):
    """JoSAA/CSAB participating-institute lists (central government institutes).

    IITs, NITs, IIITs and GFTIs publish their institute tables on the JoSAA
    (josaa.nic.in) and CSAB (csab.nic.in) portals each cycle. Listing URLs are
    operator-extendable via ``JOSAA_LISTING_URLS`` — the portals move pages
    between admission rounds.
    """

    domain = "colleges"
    name = "josaa_csab"
    display_name = "JoSAA/CSAB institutes"
    tier = 1
    base_url = "https://josaa.nic.in"
    default_urls = (
        "https://josaa.nic.in/institutes-participating/",
    )

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch
        urls = [u.strip() for u in os.environ.get("JOSAA_LISTING_URLS", "").split(",") if u.strip()]
        urls = urls or list(self.default_urls)
        records: list[RawDiscovery]
        records = []
        failures = 0
        for url in urls:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001 - try the next listing
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            rows = parse_html_tables(resp.text, url) + parse_json_ld_colleges(resp.text, url)
            for row in rows:
                if not row.get("name"):
                    continue
                row.setdefault("institution_type", "central_government")
                row.setdefault("source_url", url)
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="html_table"))
        if not records and failures:
            raise SourceTemporarilyUnavailable(f"josaa: all {failures} listing pages unavailable")
        return records


class StatePortalAdapter(SourceAdapter):
    """Generic state higher-education portal adapter.

    Reads ``COLLEGE_STATE_PORTALS`` as ``State=URL`` pairs (comma separated), e.g.
    ``Maharashtra=https://dte.maharashtra.gov.in/institutes``. One adapter instance
    can therefore cover every state the operator enables without new code.
    """

    domain = "colleges"
    name = "state_portals"
    display_name = "State higher-education portals"
    tier = 2

    def __init__(self, redis_client=None, db=None):
        super().__init__(redis_client, db)
        self._portals = self._load_portals()

    @staticmethod
    def _load_portals() -> list[tuple[str, str]]:
        raw = os.environ.get("COLLEGE_STATE_PORTALS", "").strip()
        portals: list[tuple[str, str]] = []
        for chunk in raw.split(","):
            if "=" not in chunk:
                continue
            state, url = chunk.split("=", 1)
            state, url = state.strip(), url.strip()
            if state and url.startswith("http"):
                portals.append((state, url))
        return portals

    async def discover(self) -> list[RawDiscovery]:
        if not self._portals:
            raise SourceTemporarilyUnavailable("COLLEGE_STATE_PORTALS not configured")
        from ...utils.http_client import fetch
        records: list[RawDiscovery] = []
        failures = 0
        for state, url in self._portals:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            rows = parse_html_tables(resp.text, url, default_state=state)
            if not rows and ("csv" in url.lower() or "download" in url.lower()):
                rows = parse_csv_colleges(resp.text, url, default_state=state)
            for row in rows:
                records.append(RawDiscovery(source=f"state_portal_{state.lower()}", payload=row,
                                            source_url=url, extraction_method="state_portal"))
        if not records and failures:
            raise SourceTemporarilyUnavailable(f"all {failures} state portals unavailable")
        return records


class OfficialSiteCollegeAdapter(SourceAdapter):
    """Discovers/refreshes colleges from a configured list of official sites.

    Prefers JSON-LD structured data (the mechanism institutions use for search
    engines); falls back to contact-page tables. Configured via
    ``COLLEGE_DISCOVERY_URLS`` (comma separated).
    """

    domain = "colleges"
    name = "official_sites"
    display_name = "Official college websites"
    tier = 3

    async def discover(self) -> list[RawDiscovery]:
        urls = [u.strip() for u in os.environ.get("COLLEGE_DISCOVERY_URLS", "").split(",") if u.strip()]
        if not urls:
            raise SourceTemporarilyUnavailable("COLLEGE_DISCOVERY_URLS not configured")
        from ...utils.http_client import fetch
        records: list[RawDiscovery] = []
        failures = 0
        for url in urls:
            try:
                resp = await fetch(url, timeout=45, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            found = parse_json_ld_colleges(resp.text, url)
            found += [r for r in parse_html_tables(resp.text, url) if r.get("name")]
            for row in found:
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="official_site"))
        if not records and failures:
            raise SourceTemporarilyUnavailable(f"all {failures} official sites unavailable")
        return records


class AicteInstitutionsAdapter(SourceAdapter):
    """AICTE approved-institution listings (public pages/tables).

    AICTE publishes its approved-institution data as web pages whose table shape
    changes between releases, so the adapter reads whatever tables/JSON-LD the
    page actually provides and reports zero rather than guessing when the shape
    is unfamiliar. Additional listing URLs can be appended via
    ``AICTE_LISTING_URLS``.
    """

    domain = "colleges"
    name = "aicte"
    display_name = "AICTE approved institutions"
    tier = 1
    base_url = "https://www.aicte-india.org"
    default_urls = (
        "https://www.aicte-india.org/education/institutions",
        "https://www.aicte-india.org/bulletins",
    )
    verification_note = (
        "Public institution pages only; table shape varies by release, so zero rows "
        "is a valid outcome (EXTERNAL_DEPENDENCY for live HTTP)."
    )

    @property
    def urls(self) -> list[str]:
        configured = [u.strip() for u in os.environ.get("AICTE_LISTING_URLS", "").split(",") if u.strip()]
        return configured or list(self.default_urls)

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        failures = 0
        for url in self.urls:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001 - try the next listing
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            rows = parse_html_tables(resp.text, url) + parse_json_ld_colleges(resp.text, url)
            for row in rows:
                if not row.get("name"):
                    continue
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="html_table"))
        if not records and failures == len(self.urls):
            raise SourceTemporarilyUnavailable(f"all {failures} AICTE listings unavailable")
        return records


class StateTpoAdapter(SourceAdapter):
    """State Directorate of Technical Education TPO/placement-cell member lists.

    Several states publish their TPO member lists as public tables. Configure one
    or more entries as ``STATE_TPO_URLS`` in the form ``url|State Name``
    (comma-separated). Without configuration the adapter is skipped — it never
    guesses a URL, and the state is required so the rows are attributed correctly.
    """

    domain = "colleges"
    name = "state_tpo_lists"
    display_name = "State DTE TPO lists"
    tier = 2
    enabled_by_default = bool(os.environ.get("STATE_TPO_URLS", "").strip())
    verification_note = (
        "Configured public state TPO/placement lists only; disabled until "
        "STATE_TPO_URLS is set (url|State)."
    )

    @staticmethod
    def parse_config(raw: Optional[str]) -> list[tuple[str, Optional[str]]]:
        entries: list[tuple[str, Optional[str]]] = []
        for chunk in (raw or "").split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            if "|" in chunk:
                url, state = chunk.split("|", 1)
                entries.append((url.strip(), state.strip() or None))
            else:
                entries.append((chunk, None))
        return entries

    async def discover(self) -> list[RawDiscovery]:
        entries = self.parse_config(os.environ.get("STATE_TPO_URLS", ""))
        if not entries:
            raise SourceTemporarilyUnavailable("STATE_TPO_URLS not configured")
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        failures = 0
        for url, state in entries:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            for row in parse_html_tables(resp.text, url, default_state=state):
                if not row.get("name"):
                    continue
                row.setdefault("state", state)
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="state_tpo_table"))
        if not records and failures == len(entries):
            raise SourceTemporarilyUnavailable(f"all {failures} state TPO lists unavailable")
        return records


class CollegeDatasetAdapter(SourceAdapter):
    """Public college datasets (CSV/JSON) — official exports and open data repos.

    Configured via ``COLLEGE_DATASET_URLS`` (comma-separated). Each entry may carry
    a default state using ``url|State``. Nothing is fetched without configuration.
    """

    domain = "colleges"
    name = "college_datasets"
    display_name = "Public college datasets"
    tier = 2
    enabled_by_default = bool(os.environ.get("COLLEGE_DATASET_URLS", "").strip())
    verification_note = (
        "Configured public CSV/JSON datasets only; disabled until "
        "COLLEGE_DATASET_URLS is set."
    )

    async def discover(self) -> list[RawDiscovery]:
        entries = StateTpoAdapter.parse_config(os.environ.get("COLLEGE_DATASET_URLS", ""))
        if not entries:
            raise SourceTemporarilyUnavailable("COLLEGE_DATASET_URLS not configured")
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        failures = 0
        for url, state in entries:
            try:
                resp = await fetch(url, timeout=120, min_engine="httpx", max_engine="curl")
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            text = resp.text.lstrip()
            if text.startswith(("[", "{")):
                rows = parse_json_ld_colleges(text, url) or _parse_generic_json_colleges(text, url)
                method = "dataset_json"
            else:
                rows = parse_csv_colleges(text, url, default_state=state)
                method = "dataset_csv"
            for row in rows:
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method=method))
        if not records and failures == len(entries):
            raise SourceTemporarilyUnavailable(f"all {failures} datasets unavailable")
        return records


def _parse_generic_json_colleges(text: str, source_url: str) -> list[dict]:
    """Open datasets use many key spellings; read the ones we can justify."""
    import json as _json

    try:
        data = _json.loads(text)
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        items = next((v for v in data.values() if isinstance(v, list) and v and isinstance(v[0], dict)), [])
    else:
        items = [i for i in data if isinstance(i, dict)] if isinstance(data, list) else []
    rows: list[dict] = []
    for item in items:
        lower = {str(k).strip().lower(): v for k, v in item.items()}
        name = clean_text(
            lower.get("name") or lower.get("college_name") or lower.get("institute_name")
            or lower.get("institution_name") or lower.get("college")
        )
        if not name:
            continue
        rows.append({
            "name": name,
            "official_name": clean_text(lower.get("official_name")),
            "aishe_code": clean_text(lower.get("aishe_code") or lower.get("aishe")),
            "state": clean_text(lower.get("state") or lower.get("state_name")),
            "district": clean_text(lower.get("district") or lower.get("district_name")),
            "city": clean_text(lower.get("city") or lower.get("town")),
            "pincode": clean_text(lower.get("pincode") or lower.get("pin")),
            "institution_type": clean_text(lower.get("institution_type") or lower.get("type")),
            "ownership": clean_text(lower.get("ownership") or lower.get("management")),
            "website_url": clean_text(lower.get("website_url") or lower.get("website")),
            "official_email": clean_text(lower.get("official_email") or lower.get("email")),
            "phone": clean_text(lower.get("phone") or lower.get("phone_number")),
            "university_affiliation": clean_text(lower.get("university") or lower.get("affiliation")),
            "source_url": source_url,
            "raw_payload": item,
        })
    return rows


class PausedDirectoryAdapter(SourceAdapter):
    """Base for public directories that need a terms/reliability review first.

    The adapters exist and are unit-tested offline; they stay disabled until an
    operator enables them after reviewing the site's terms of use. Parsing is the
    same public table extraction the enabled sources use, so enabling one is a
    configuration decision rather than new code.
    """

    domain = "colleges"
    enabled_by_default = False
    verification_note = "Disabled pending a source terms review; parser unit-tested offline."

    @property
    def urls(self) -> list[str]:
        raw = os.environ.get(f"{self.name.upper()}_URLS", "")
        configured = [u.strip() for u in raw.split(",") if u.strip()]
        return configured or list(getattr(self, "default_urls", ()))

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        failures = 0
        urls = self.urls
        for url in urls:
            try:
                resp = await fetch(url, timeout=60, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            for row in parse_html_tables(resp.text, url) + parse_json_ld_colleges(resp.text, url):
                if not row.get("name"):
                    continue
                records.append(RawDiscovery(source=self.name, payload=row, source_url=url,
                                            extraction_method="directory"))
        if not records and urls and failures == len(urls):
            raise SourceTemporarilyUnavailable(f"all {failures} {self.name} listings unavailable")
        return records


class Careers360Adapter(PausedDirectoryAdapter):
    """Careers360 college directory (public listing; terms review required)."""

    name = "careers360"
    display_name = "Careers360 directory"
    tier = 3
    base_url = "https://www.careers360.com"
    default_urls = ("https://www.careers360.com/colleges/list-of-colleges-in-india",)


class ShikshaAdapter(PausedDirectoryAdapter):
    """Shiksha college directory (public listing; terms review required)."""

    name = "shiksha"
    display_name = "Shiksha directory"
    tier = 3
    base_url = "https://www.shiksha.com"
    default_urls = ("https://www.shiksha.com/colleges",)


class CollegeDekhoAdapter(PausedDirectoryAdapter):
    """CollegeDekho directory (public listing; terms review required)."""

    name = "collegedekho"
    display_name = "CollegeDekho directory"
    tier = 3
    base_url = "https://www.collegedekho.com"
    default_urls = ("https://www.collegedekho.com/colleges/",)


class CollegeduniaAdapter(PausedDirectoryAdapter):
    """Collegedunia directory (public listing; terms review required)."""

    name = "collegedunia"
    display_name = "Collegedunia directory"
    tier = 3
    base_url = "https://collegedunia.com"
    default_urls = ("https://collegedunia.com/colleges",)


class TeluguCollegesAdapter(PausedDirectoryAdapter):
    """TeluguColleges (Telangana/AP) directory (public listing; terms review required)."""

    name = "telugucolleges"
    display_name = "TeluguColleges directory"
    tier = 3
    base_url = "https://www.telugucolleges.com"


class PtuAffiliatedAdapter(PausedDirectoryAdapter):
    """Punjab Technical University affiliated-college list (public listing)."""

    name = "ptu_affiliated"
    display_name = "PTU affiliated colleges"
    tier = 2
    base_url = "https://ptu.ac.in"
    default_urls = ("https://ptu.ac.in/colleges/",)


COLLEGE_ADAPTERS: tuple[type[SourceAdapter], ...] = (
    AisheAdapter,
    AicteInstitutionsAdapter,
    UgcUniversitiesAdapter,
    NirfAdapter,
    NaacAdapter,
    JoSaaInstitutesAdapter,
    StatePortalAdapter,
    StateTpoAdapter,
    CollegeDatasetAdapter,
    OfficialSiteCollegeAdapter,
    Careers360Adapter,
    ShikshaAdapter,
    CollegeDekhoAdapter,
    CollegeduniaAdapter,
    TeluguCollegesAdapter,
    PtuAffiliatedAdapter,
)
