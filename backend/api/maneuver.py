from fastapi import APIRouter
import numpy as np

from state.objects import get_objects, add_maneuver
from physics.fuel import fuel_required
from communication.los import has_los
from communication.stations import stations

router = APIRouter()

MAX_DV = 0.015  # km/s
COOLDOWN = 600


@router.post("/api/maneuver/schedule")

def schedule_maneuver(data: dict):

    objects = get_objects()

    sat_id = data["satelliteId"]

    if sat_id not in objects:
        return {"status":"REJECTED","reason":"Satellite not found"}

    sat = objects[sat_id]

    sat_pos = np.array(sat["state"][:3])

    validation = {
        "ground_station_los": False,
        "sufficient_fuel": False,
        "projected_mass_remaining_kg": sat["mass"]
    }

    total_fuel = 0.0
    current_mass = sat["mass"]

    for seq in data["maneuver_sequence"]:

        dv = np.array([
            seq["deltaV_vector"]["x"],
            seq["deltaV_vector"]["y"],
            seq["deltaV_vector"]["z"]
        ])

        if np.linalg.norm(dv) > MAX_DV:
            return {"status":"REJECTED","reason":"Delta-V exceeds limit"}

        fuel = fuel_required(current_mass, dv)
        total_fuel += fuel
        current_mass -= fuel

        if total_fuel > sat["fuel"]:
            return {"status":"REJECTED","reason":"Insufficient fuel"}

        for station in stations:
            if has_los(sat_pos, station):
                validation["ground_station_los"] = True
                break

        validation["sufficient_fuel"] = True
        validation["projected_mass_remaining_kg"] = current_mass

    if not validation["ground_station_los"]:
        return {"status":"REJECTED","reason":"No LOS to ground station"}

    add_maneuver(data)

    sat["fuel"] -= total_fuel
    sat["mass"] -= total_fuel

    return {
        "status":"SCHEDULED",
        "validation": validation
    }