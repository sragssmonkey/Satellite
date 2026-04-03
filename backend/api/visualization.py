from fastapi import APIRouter
from state.objects import get_objects
import numpy as np
from conjuction.detection import detect_future_conjunctions

router = APIRouter()

def get_geographic_coords(xyz):
    x, y, z = xyz[:3]
    r = np.sqrt(x**2 + y**2 + z**2)
    if r == 0:
        return 0.0, 0.0
    
    lat = np.degrees(np.arcsin(np.clip(z / r, -1.0, 1.0)))
    lon = np.degrees(np.arctan2(y, x))
    return lat, lon

@router.get("/api/visualization/snapshot")
def snapshot():

    objects = get_objects()

    satellites = []
    debris = []

    for obj_id, sat in objects.items():

        state = sat["state"]
        lat, lon = get_geographic_coords(state)

        if sat["type"] == "SATELLITE":

            fuel = sat.get("fuel", 50.0)
            initial = sat.get("initial_fuel", 50.0)

            ratio = fuel / initial if initial > 0 else 0
            fuel_percent = ratio * 100
            
            # status logic (INSIDE loop)
            if ratio <= 0.05:
                status = "EOL_PENDING"
            elif ratio <= 0.2:
                status = "LOW_FUEL"
            else:
                status = "NOMINAL"

            satellites.append({
                "id": obj_id,
                "lat": lat,
                "lon": lon,
                "fuel_kg": round(fuel, 2),
                "fuel_percent": round(fuel_percent, 1),
                "status": status
            })

        else:
            # For debris, return simple array for performance
            debris.append([
                obj_id,
                lat,
                lon,
                state[2] # alt or z is used for some cases, but lat/lon/id is what frontend needs
            ])

    return {
        "timestamp": 0,
        "satellites": satellites,
        "debris_cloud": debris
    }

@router.get("/api/visualization/conjunctions")
def get_conjunctions():
    objects = get_objects()
    state_map = {k: v["state"] for k, v in objects.items() if len(v.get("state", [])) >= 6}
    alerts = detect_future_conjunctions(state_map)
    return {"alerts": alerts}

@router.get("/api/visualization/maneuvers")
def get_maneuvers_log():
    from state.objects import get_maneuvers
    return {"maneuvers": get_maneuvers()}

@router.get("/api/visualization/efficiency")  
def get_efficiency():
    from logs.efficiency_log import get_efficiency_data
    return {"log": get_efficiency_data()}
