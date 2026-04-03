import numpy as np

Isp = 300.0
g0 = 9.80665

def fuel_required(mass, dv):

    if hasattr(dv, '__len__'):
        dv_mag = np.linalg.norm(dv) * 1000
    else:
        dv_mag = dv * 1000

    delta_m = mass * (1 - np.exp(-dv_mag / (Isp * g0)))

    return delta_m

def compute_fuel_used(mass, dv):
    return fuel_required(mass, dv)