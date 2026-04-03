from fastapi import FastAPI
import json
import os
from api.telemetry import router as telemetry_router
from api.maneuver import router as maneuver_router
from api.simulate import router as simulation_router
from api.visualization import router as visualization_router
from state.objects import update_object
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# Initial Data Load
# backend/main.py — replace the startup_event function:
@app.on_event("startup")
async def startup_event():
    data_path = os.path.join(os.path.dirname(__file__), "data", "objects.json")
    if not os.path.exists(data_path):
        return
    try:
        with open(data_path, "r") as f:
            data = json.load(f)
        from state.objects import get_objects
        for obj in data:
            update_object(obj["id"], obj["state"], obj["type"])
            objs = get_objects()
            if obj["id"] in objs:
                o = objs[obj["id"]]
                o["fuel"]          = obj.get("fuel", 50.0)
                o["initial_fuel"]  = obj.get("initial_fuel", 50.0)
                o["mass"]          = obj.get("mass", 550.0)
                o["slot_position"] = list(obj["state"][:3])  # ← FIX: set slot
                o["outage_seconds"]= 0                        # ← FIX: init outage
                o["last_burn_time"]= -10000
        print(f"Loaded {len(data)} objects")
    except Exception as e:
        print(f"Startup error: {e}")

app.include_router(telemetry_router)
app.include_router(maneuver_router)
app.include_router(simulation_router)
app.include_router(visualization_router)