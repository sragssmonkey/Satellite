# backend/test_api.py
import requests, json, time

BASE = "http://localhost:8000"

def test(name, method, url, body=None):
    try:
        r = requests.request(method, BASE+url, json=body, timeout=5)
        status = "PASS" if r.status_code < 300 else "FAIL"
        print(f"[{status}] {name} → {r.status_code} | {r.text[:120]}")
        return r.json()
    except Exception as e:
        print(f"[ERROR] {name} → {e}")
        return {}

print("\n=== SNAPSHOT ===")
snap = test("Snapshot", "GET", "/api/visualization/snapshot")
sats = len(snap.get("satellites", []))
deb  = len(snap.get("debris_cloud", []))
print(f"  Satellites: {sats}  Debris: {deb}")

print("\n=== TELEMETRY ===")
test("Telemetry ingest", "POST", "/api/telemetry", {
    "timestamp": "2026-03-12T08:00:00.000Z",
    "objects": [{"id":"TEST-DEB-001","type":"DEBRIS",
                 "r":{"x":4500.2,"y":-2100.5,"z":4800.1},
                 "v":{"x":-1.25,"y":6.84,"z":3.12}}]
})

print("\n=== SIMULATE ===")
test("Simulate 60s", "POST", "/api/simulate/step", {"step_seconds": 60})
test("Simulate 3600s", "POST", "/api/simulate/step", {"step_seconds": 3600})

print("\n=== MANEUVER ===")
if sats > 0:
    sat_id = snap["satellites"][0]["id"]
    test("Schedule maneuver", "POST", "/api/maneuver/schedule", {
        "satelliteId": sat_id,
        "maneuver_sequence": [{
            "burn_id": "TEST_BURN_1",
            "burnTime": "2026-03-12T14:15:30.000Z",
            "deltaV_vector": {"x": 0.002, "y": 0.005, "z": -0.001}
        }]
    })

print("\n=== CONJUNCTIONS ===")
conj = test("Conjunctions", "GET", "/api/visualization/conjunctions")
print(f"  Active alerts: {len(conj.get('alerts', []))}")

print("\n=== EFFICIENCY ===")
test("Efficiency log", "GET", "/api/visualization/efficiency")

print("\nDone. Fix any [FAIL] lines above.")