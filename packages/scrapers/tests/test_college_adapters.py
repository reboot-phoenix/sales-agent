"""College adapter parsers (offline). Live portals are EXTERNAL_DEPENDENCY."""
import json

from scrapers.domains.colleges.adapters import (
    canonical_header,
    parse_csv_colleges,
    parse_html_tables,
    parse_json_ld_colleges,
)

TABLE_HTML = """
<table>
  <tr><th>Institution Name</th><th>State</th><th>Website</th><th>AISHE Code</th></tr>
  <tr>
    <td><a href="https://abc.edu">ABC Institute of Technology</a></td>
    <td>Tamil Nadu</td>
    <td><a href="https://abc.edu">abc.edu</a></td>
    <td>C-12345</td>
  </tr>
</table>
"""


def test_canonical_header_maps_variants():
    assert canonical_header("Institution Name") == "name"
    assert canonical_header("AISHE Code") == "aishe_code"
    assert canonical_header("Website URL") == "website_url"
    assert canonical_header("District") == "district"
    assert canonical_header("Random Column") is None


def test_parse_html_tables_extracts_rows_and_links():
    rows = parse_html_tables(TABLE_HTML, "https://ugc.gov.in/list", default_state="Tamil Nadu")
    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == "ABC Institute of Technology"
    assert row["state"] == "Tamil Nadu"
    assert row["aishe_code"] == "C-12345"
    assert row["website_url"] == "https://abc.edu"


def test_parse_html_tables_ignores_tables_without_a_name_column():
    html = "<table><tr><th>Rank</th><th>Score</th></tr><tr><td>1</td><td>99</td></tr></table>"
    assert parse_html_tables(html, "https://x") == []


def test_parse_json_ld_college():
    entity = {
        "@type": "CollegeOrUniversity",
        "name": "ABC Institute",
        "legalName": "ABC Institute of Technology",
        "url": "https://abc.edu",
        "email": "office@abc.edu",
        "telephone": "+91 44 1234 5678",
        "address": {"streetAddress": "1 College Rd", "addressLocality": "Chennai",
                    "addressRegion": "Tamil Nadu", "postalCode": "600001", "addressCountry": "IN"},
    }
    html = f'<script type="application/ld+json">{json.dumps(entity)}</script>'
    rows = parse_json_ld_colleges(html, "https://abc.edu")
    assert len(rows) == 1
    assert rows[0]["name"] == "ABC Institute"
    assert rows[0]["city"] == "Chennai"
    assert rows[0]["pincode"] == "600001"
    assert rows[0]["extraction_method"] == "json_ld"


def test_parse_csv_colleges_maps_headers():
    csv_text = (
        "Institution Name,State,District,City,Website,AISHE Code\n"
        "XYZ College,Kerala,Ernakulam,Kochi,https://xyz.edu,C-999\n"
    )
    rows = parse_csv_colleges(csv_text, "https://aishe.gov.in/dump.csv")
    assert len(rows) == 1
    assert rows[0]["name"] == "XYZ College"
    assert rows[0]["city"] == "Kochi"
    assert rows[0]["website_url"] == "https://xyz.edu"


def test_parse_csv_applies_default_state():
    csv_text = "Name,City\nFoo College,Pune\n"
    rows = parse_csv_colleges(csv_text, "https://dte.maharashtra.gov.in/x", default_state="Maharashtra")
    assert rows[0]["state"] == "Maharashtra"
