"""Provider layer: only configured providers run, and nothing is invented.

The HTTP calls are replaced with fakes, so these tests assert the *rules*:
no key means no call, off-domain addresses are dropped, generic inboxes are kept
but never promoted to a named decision maker, and one provider failing does not
stop the others.
"""
import pytest

from scrapers.domains import providers


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for spec in providers.PROVIDERS.values():
        for var in spec.env_vars:
            monkeypatch.delenv(var, raising=False)
    yield


def test_nothing_is_configured_by_default():
    assert providers.configured_providers() == []
    status = providers.provider_status()
    assert status["hunter"]["configured"] is False
    # Provider parity: what is implemented is stated, what is not is stated too.
    assert status["hunter"]["implemented"] is True
    assert status["rocketreach"]["implemented"] is False
    assert status["rocketreach"]["env_vars"] == ["ROCKETREACH_API_KEY"]


@pytest.mark.asyncio
async def test_no_key_means_no_network_call(monkeypatch):
    called = []

    async def boom(*args, **kwargs):
        called.append(args)
        raise AssertionError("provider must not be called without a key")

    monkeypatch.setattr(providers, "_get_json", boom)
    monkeypatch.setattr(providers, "_post_json", boom)

    result = await providers.enrich_with_providers(website_domain="https://college.edu")

    assert called == []
    assert result == {"contacts": [], "providers_used": [], "errors": []}


@pytest.mark.asyncio
async def test_hunter_results_are_tagged_and_verified_only_when_hunter_says_so(monkeypatch):
    monkeypatch.setenv("HUNTER_API_KEY", "k")

    async def fake_get(url, **kwargs):
        assert "domain=college.edu" in url and "api_key=k" in url
        return {"data": {"emails": [
            {"first_name": "A", "last_name": "Sharma", "position": "Training and Placement Officer",
             "value": "tpo@college.edu", "verification": {"status": "valid"}, "confidence": 91},
            {"value": "principal@college.edu", "verification": {"status": "unknown"}},
            {"value": "someone@gmail.com", "verification": {"status": "valid"}},
            {"value": "noreply@college.edu", "verification": {"status": "valid"}},
        ]}}

    monkeypatch.setattr(providers, "_get_json", fake_get)

    result = await providers.enrich_with_providers(website_domain="college.edu")

    assert result["providers_used"] == ["hunter"]
    emails = [c["email"] for c in result["contacts"]]
    assert emails == ["tpo@college.edu", "principal@college.edu"]  # off-domain + noreply dropped
    by_email = {c["email"]: c for c in result["contacts"]}
    assert by_email["tpo@college.edu"]["verification_status"] == "verified"
    assert by_email["tpo@college.edu"]["role_category"] == "tpo"
    assert by_email["tpo@college.edu"]["full_name"] == "A Sharma"
    assert by_email["tpo@college.edu"]["contact_source"] == "hunter_api"
    # An address the provider will not vouch for stays unverified.
    assert by_email["principal@college.edu"]["verification_status"] == "unverified"


@pytest.mark.asyncio
async def test_one_provider_failing_does_not_stop_the_others(monkeypatch):
    monkeypatch.setenv("HUNTER_API_KEY", "k")
    monkeypatch.setenv("APOLLO_API_KEY", "k")

    async def failing_get(url, **kwargs):
        raise RuntimeError("502 from hunter")

    async def ok_post(url, **kwargs):
        return {"people": [{"name": "B Rao", "title": "Principal", "email": "principal@college.edu",
                            "email_status": "verified"}]}

    monkeypatch.setattr(providers, "_get_json", failing_get)
    monkeypatch.setattr(providers, "_post_json", ok_post)

    result = await providers.enrich_with_providers(website_domain="college.edu")

    assert result["providers_used"] == ["apollo"]
    assert any("hunter" in err for err in result["errors"])
    assert result["contacts"][0]["email"] == "principal@college.edu"


@pytest.mark.asyncio
async def test_missing_domain_is_reported_not_guessed():
    result = await providers.enrich_with_providers(website_domain=None)
    assert result["contacts"] == []
    assert result["errors"] == ["no domain on record"]


def test_off_domain_and_role_helpers():
    assert providers.classify_email("placements@college.edu") == "tpo"
    assert providers.classify_email("registrar@college.edu") == "official"
    assert providers.classify_email("someone@gmail.com") is None
    assert providers.classify_email(None) is None

    kept = providers.normalize_provider_contacts(
        [{"email": "INFO@College.edu", "full_name": None}], provider="hunter", website_domain="college.edu")
    assert kept and kept[0]["email"] == "info@college.edu"
    assert kept[0]["role_category"] == "other"
    # A contact with no locator at all is not a contact.
    assert providers.normalize_provider_contacts([{"full_name": "No Contact"}],
                                                provider="hunter", website_domain="college.edu") == []
