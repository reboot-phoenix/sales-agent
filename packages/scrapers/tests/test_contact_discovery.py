"""Contact-page discovery: known paths, sitemap, and homepage role links.

All offline — `fetch` is injected, so nothing here depends on a live site.
"""
import pytest

from scrapers.domains import contact_discovery as cd


class FakeResponse:
    def __init__(self, text="", status=200):
        self.text = text
        self.status = status


class FakeFetcher:
    """Maps URL -> response; records every URL requested."""

    def __init__(self, pages: dict):
        self.pages = pages
        self.requested: list[str] = []

    async def __call__(self, url, **kwargs):
        self.requested.append(url)
        page = self.pages.get(url)
        if page is None:
            return FakeResponse("", 404)
        return FakeResponse(page, 200)


def test_known_paths_cover_the_placement_shapes_colleges_actually_use():
    urls = cd.candidate_contact_urls("https://www.college.edu")
    assert urls[0] == "https://college.edu"  # homepage first
    assert "https://college.edu/placement" in urls
    assert "https://college.edu/training-and-placement-cell" in urls
    assert "https://college.edu/tpo" in urls
    assert "https://college.edu/principal" in urls
    # Bounded: never an unbounded crawl from one site.
    assert len(urls) <= cd.MAX_CANDIDATE_URLS
    assert cd.candidate_contact_urls(None) == []
    assert cd.candidate_contact_urls("not a url") == []


def test_role_links_are_same_site_only_and_skip_documents_and_auth_pages():
    html = """
      <a href="/training-and-placement">Training &amp; Placement</a>
      <a href="/login">Principal login</a>
      <a href="/placement-report.pdf">Placement report</a>
      <a href="https://other-university.edu/placement">Other site</a>
      <a href="/blog/post">Contact blog</a>
      <a href="/about/our-principal">Our Principal</a>
    """
    links = cd.extract_role_links(html, "https://college.edu/")
    assert "https://college.edu/training-and-placement" in links
    assert "https://college.edu/about/our-principal" in links
    assert not any("other-university" in link for link in links)
    assert not any(link.endswith(".pdf") for link in links)
    assert not any("/login" in link for link in links)
    assert not any("/blog" in link for link in links)


def test_sitemap_parsing_handles_indexes_and_robots_style_entries():
    index = '<sitemapindex><sitemap><loc>https://x.edu/sitemap-1.xml</loc></sitemap></sitemapindex>'
    parsed = cd.parse_sitemap_urls(index)
    assert parsed["nested"] == ["https://x.edu/sitemap-1.xml"]

    # A robots.txt Sitemap: line points at a sitemap document, so it is returned
    # as nested (to be fetched and parsed), never as an item page.
    robots = "User-agent: *\nDisallow: /admin\nSitemap: https://x.edu/sitemap.xml\n"
    parsed_robots = cd.parse_sitemap_urls(robots)
    assert parsed_robots["nested"] == ["https://x.edu/sitemap.xml"]
    assert parsed_robots["urls"] == []
    assert cd.parse_sitemap_urls("") == {"urls": [], "nested": []}


@pytest.mark.asyncio
async def test_sitemap_discovery_only_keeps_role_relevant_pages():
    fetcher = FakeFetcher({
        "https://college.edu/sitemap.xml": (
            "<urlset>"
            "<url><loc>https://college.edu/placement-cell</loc></url>"
            "<url><loc>https://college.edu/blog/event-photos</loc></url>"
            "<url><loc>https://facebook.com/college/placement</loc></url>"
            "</urlset>"
        ),
    })
    urls = await cd.discover_sitemap_urls("https://college.edu", fetch=fetcher)
    assert urls == ["https://college.edu/placement-cell"]


@pytest.mark.asyncio
async def test_discovery_falls_through_to_homepage_links_when_no_sitemap():
    fetcher = FakeFetcher({
        "https://college.edu/": '<html><a href="/tp-cell-contacts">TPO cell</a></html>',
    })
    urls = await cd.discover_contact_urls("https://college.edu", fetch=fetcher, limit=40)
    # Known paths still come first; the discovered page is appended, not dropped.
    assert urls[0] == "https://college.edu"
    assert "https://college.edu/tp-cell-contacts" in urls


@pytest.mark.asyncio
async def test_discovery_is_bounded_and_deduplicated():
    fetcher = FakeFetcher({
        "https://college.edu/sitemap.xml": "<urlset>" + "".join(
            f"<url><loc>https://college.edu/placement-{i}</loc></url>" for i in range(50)
        ) + "</urlset>",
    })
    urls = await cd.discover_contact_urls("https://college.edu", fetch=fetcher, limit=20)
    assert len(urls) == len(set(urls))
    assert len(urls) <= 20


@pytest.mark.asyncio
async def test_network_failure_never_raises_out_of_discovery():
    class Boom:
        async def __call__(self, url, **kwargs):
            raise RuntimeError("dns failure")

    urls = await cd.discover_contact_urls("https://college.edu", fetch=Boom())
    # Known paths survive; discovery failure is not fatal.
    assert urls == cd.candidate_contact_urls("https://college.edu")
