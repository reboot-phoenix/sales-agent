"""Domain intelligence layer: hackathons + colleges (jobs live in scrapers/*).

Nothing here is domain-specific; each domain gets its own package under this
namespace. The shared modules exist so job/hackathon/college discovery do not
each reinvent normalization, entity resolution, quality scoring or provenance.
"""

DOMAINS = ("jobs", "hackathons", "colleges")

__all__ = ["DOMAINS"]
