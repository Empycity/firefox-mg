"""Small runtime helpers shared by the pure-Node FeiLin path."""
import os
import random


def resolve_gather_cost(explicit=None) -> int:
    """Return the FeiLin collection duration shared by DeviceToken and Log2."""
    raw = explicit if explicit is not None else os.environ.get('GATHER_COST_MS')
    if raw is None:
        return random.randint(6500, 8500)
    value = int(raw)
    if not 0 <= value <= 120000:
        raise ValueError('GatherCost must be between 0 and 120000 ms')
    return value
