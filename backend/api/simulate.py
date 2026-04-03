from fastapi import APIRouter
import numpy as np

from acm.decision_engine import autonomous_maneuver_planner
from acm.eol_manager import schedule_eol_maneuver

from state.objects import get_objects, get_maneuvers

from physics.rk4 import rk4_step
from physics.fuel import compute_fuel_used
from acm.station_keeper import check_station_keeping
from acm.uptime_monitor import compute_uptime_score

from conjuction.detection import detect_future_conjunctions

from logs.fuel_log import log_fuel_state
from logs.efficiency_log import log_efficiency

from pydantic import BaseModel

import datetime

BASE_TIME = datetime.datetime(2026, 3, 12, 8, 0, 0, tzinfo=datetime.timezone.utc)

# -------------------------
# CONSTANTS (from spec)
# -------------------------

MAX_DV = 0.015      # km/s (15 m/s)
COOLDOWN = 600      # seconds


class StepRequest(BaseModel):
    step_seconds: int


router = APIRouter()

current_time = 0


@router.post("/api/simulate/step")
def simulate(data: StepRequest):

    global current_time

    dt = data.step_seconds

    objects = get_objects()
    maneuvers = get_maneuvers()

    collisions = 0
    maneuvers_executed = 0

    # ⭐ Track efficiency
    fuel_used_this_step = 0.0

    # -------------------------
    # 1️⃣ PROPAGATE ORBITS
    # -------------------------

    for obj_id, obj in objects.items():

        state = np.array(obj["state"], dtype=float)

        obj["state"] = rk4_step(state, dt)

    # -------------------------
    # ⭐ CHECK SLOT DRIFT
    # -------------------------

    outages = check_station_keeping(
        objects,
        dt
    )
    from logs.outage_log import log_outage

    log_outage(
        current_time,
        outages
    )
    current_time += dt


    # -------------------------
    # 2️⃣ EXECUTE MANEUVERS
    # -------------------------

    for m in maneuvers:

        sat_id = m["satelliteId"]

        if sat_id not in objects:
            continue

        sat = objects[sat_id]

        for burn in m["maneuver_sequence"]:

            if burn.get("executed", False):
                continue

            burn_time = burn["burnTime"]

            # ⭐ cooldown check
            if current_time - sat["last_burn_time"] < COOLDOWN:
                continue

            # ⭐ latency check
            if burn_time > current_time:
                continue

            dv = np.array([
                burn["deltaV_vector"]["x"],
                burn["deltaV_vector"]["y"],
                burn["deltaV_vector"]["z"]
            ])

            # -------------------------
            # LIMIT Δv
            # -------------------------

            dv_mag = np.linalg.norm(dv)

            if dv_mag > MAX_DV:

                dv = dv * (MAX_DV / dv_mag)

                dv_mag = MAX_DV


            # -------------------------
            # APPLY BURN
            # -------------------------

            sat["state"][3:] += dv


            # -------------------------
            # ROCKET EQUATION FUEL
            # -------------------------

            fuel_used = compute_fuel_used(
                sat["mass"],
                dv_mag
            )

            sat["fuel"] -= fuel_used
            sat["mass"] -= fuel_used

            if sat["fuel"] < 0:
                sat["fuel"] = 0

            # ⭐ accumulate step fuel
            fuel_used_this_step += fuel_used

            sat["last_burn_time"] = current_time

            burn["executed"] = True

            maneuvers_executed += 1


    # -------------------------
    # ⭐ LOG FUEL STATE
    # -------------------------

    log_fuel_state(objects, current_time)


    # -------------------------
    # 3️⃣ BUILD STATE MAP
    # -------------------------

    state_map = {
        k: v["state"]
        for k, v in objects.items()
        if "state" in v and len(v["state"]) >= 6
    }


    # -------------------------
    # 4️⃣ DETECT CONJUNCTIONS
    # -------------------------

    auto_maneuvers = []

    if len(state_map) >= 2:

        alerts = detect_future_conjunctions(state_map)

        for alert in alerts:

            if alert["miss_distance_km"] < 0.1:
                collisions += 1

        # -------------------------
        # 5️⃣ AUTO EVASION
        # -------------------------

        auto_maneuvers = autonomous_maneuver_planner(
            alerts,
            objects,
            current_time
        )

    else:

        alerts = []


    # -------------------------
    # 6️⃣ EOL MANAGEMENT
    # -------------------------

    eol_maneuvers = schedule_eol_maneuver(
        objects,
        current_time
    )


    # -------------------------
    # 7️⃣ PREVENT DUPLICATES
    # -------------------------

    existing_ids = {
        burn["burn_id"]
        for m in maneuvers
        for burn in m["maneuver_sequence"]
    }


    for m in auto_maneuvers:

        burn_id = m["maneuver_sequence"][0]["burn_id"]

        if burn_id not in existing_ids:
            maneuvers.append(m)


    for m in eol_maneuvers:

        burn_id = m["maneuver_sequence"][0]["burn_id"]

        if burn_id not in existing_ids:
            maneuvers.append(m)


    # -------------------------
    # ⭐ LOG EFFICIENCY
    # -------------------------

    collisions_avoided = maneuvers_executed

    log_efficiency(
        current_time,
        fuel_used_this_step,
        collisions_avoided
    )

    uptime = compute_uptime_score(objects)
    # -------------------------
    # RETURN RESULT
    # -------------------------

    ts = BASE_TIME + datetime.timedelta(seconds=current_time)

    return {
        "status": "STEP_COMPLETE",
        "new_timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "collisions_detected": collisions,
        "maneuvers_executed": maneuvers_executed,
        "uptime_percent": round(uptime, 2)
    }