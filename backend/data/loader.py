# backend/data/loader.py

import json
import datetime
import os
from sgp4.api import Satrec, jday


def parse_tle_file(tle_txt_path: str) -> list:
    """
    Reads a .txt file of TLEs (3-line format: name, line1, line2)
    and returns a list of objects in your existing state format.
    """
    objects = []

    with open(tle_txt_path, 'r') as f:
        lines = [l.strip() for l in f.readlines() if l.strip()]

    # TLE files come in groups of 3 lines: name, TLE line1, TLE line2
    now = datetime.datetime.utcnow()
    jd, fr = jday(now.year, now.month, now.day,
                  now.hour, now.minute, now.second)

    for i in range(0, len(lines) - 2, 3):
        name  = lines[i]
        line1 = lines[i + 1]
        line2 = lines[i + 2]

        try:
            sat = Satrec.twoline2rv(line1, line2)
            e, r, v = sat.sgp4(jd, fr)

            if e != 0:          # sgp4 error code — skip bad entries
                continue
            if None in r or None in v:
                continue

            obj_type = "SATELLITE" if "DEB" not in name.upper() else "DEBRIS"

            objects.append({
                "id":    str(sat.satnum),
                "type":  obj_type,
                "state": [r[0], r[1], r[2], v[0], v[1], v[2]],
                "mass":  500.0,
                "fuel":  50.0,
                "initial_fuel": 50.0,
                "last_burn_time": 0
            })

        except Exception as ex:
            print(f"Skipping {name}: {ex}")
            continue

    return objects


def save_objects_json(objects: list, out_path: str = "data/objects.json"):
    with open(out_path, 'w') as f:
        json.dump(objects, f, indent=2)
    print(f"Saved {len(objects)} objects to {out_path}")


if __name__ == "__main__":
    # Run this ONCE from inside the backend/ folder:
    # python -m data.loader
    all_objects = []
    print("📡 Processing TLE data from data/...\n")

    for file in os.listdir("data/"):
        if file.endswith(".txt") and file.startswith("tle_"):
            group = file.replace("tle_", "").replace(".txt", "")
            path = f"data/{file}"
            batch = parse_tle_file(path)

            sats = sum(1 for o in batch if o["type"] == "SATELLITE")
            debris = sum(1 for o in batch if o["type"] == "DEBRIS")
            print(f"✓ {group:<15} → {len(batch):>5} objects  (🛰 {sats} sats  🧩 {debris} debris)")

            all_objects.extend(batch)

    save_objects_json(all_objects, "data/objects.json")

    total_sats = sum(1 for o in all_objects if o["type"] == "SATELLITE")
    total_debris = sum(1 for o in all_objects if o["type"] == "DEBRIS")

    print(f"\n📦 Total: {len(all_objects)}  🛰 {total_sats} sats  🧩 {total_debris} debris")
