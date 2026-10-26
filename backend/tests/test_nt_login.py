"""NT is the sole user-facing login identifier; legacy ownership stays stable."""


def test_nt_only_registration_and_case_insensitive_login(client):
    response = client.post('/api/auth/register', json={
        'NT': 'Engineering.Alice', 'password': 'password-123', 'Department': 'engineering'})
    assert response.status_code == 201, response.text
    user = response.json()['user']
    assert user['NT'] == 'Engineering.Alice'
    client.post('/api/auth/logout')
    login = client.post('/api/auth/login', json={'NT': ' engineering.ALICE ', 'password': 'password-123'})
    assert login.status_code == 200, login.text
    assert login.json()['user']['id'] == user['id']
    duplicate = client.post('/api/auth/register', json={
        'NT': 'engineering.alice', 'password': 'password-123', 'Department': 'engineering'})
    assert duplicate.status_code == 409


def test_legacy_different_username_logs_in_by_nt_without_changing_owner(client):
    response = client.post('/api/auth/register', json={
        'username': 'legacy-alias', 'NT': 'Actual.NT', 'password': 'password-123', 'Department': 'engineering'})
    original = response.json()['user']
    assert response.status_code == 201
    client.post('/api/auth/logout')
    response = client.post('/api/auth/login', json={'NT': 'actual.nt', 'password': 'password-123'})
    assert response.status_code == 200, response.text
    assert response.json()['user']['id'] == original['id']
    assert client.post('/api/auth/login', json={'NT': 'legacy-alias', 'password': 'password-123'}).status_code == 401


def test_nt_domain_identifier_and_admin_creation(client, admin):
    created = client.post('/api/admin/users', json={
        'NT': 'DOMAIN\\Alice', 'password': 'password-123', 'Department': 'engineering'})
    assert created.status_code == 201, created.text
    response = client.post('/api/auth/login', json={'NT': 'domain\\alice', 'password': 'password-123'})
    assert response.status_code == 200
    assert response.json()['user']['id'] == created.json()['user']['id']
