def test_health_returns_ok(client) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["data"]["status"] == "ok"
    assert body["error"] is None


def test_health_no_auth_required(client) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
