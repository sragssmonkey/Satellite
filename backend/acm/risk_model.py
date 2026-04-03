# backend/acm/risk_model.py
def compute_collision_risk(tca, miss_distance):
    if miss_distance < 0.1:    # < 100m = CRITICAL
        return "HIGH"
    if miss_distance < 1.0:    # < 1km = WARNING
        return "MEDIUM"
    if miss_distance < 5.0:    # < 5km = CAUTION
        return "LOW"
    return "SAFE"
