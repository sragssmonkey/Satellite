def compute_uptime_score(objects):

    total = 0
    degraded = 0

    for sat in objects.values():

        if sat["type"] != "SATELLITE":
            continue

        total += 1

        if sat["outage_seconds"] > 0:
            degraded += 1

    if total == 0:
        return 100.0

    uptime = (
        (total - degraded)
        / total
    ) * 100

    return uptime