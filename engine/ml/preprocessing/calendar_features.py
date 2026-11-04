import pandas as pd

from config.city import SCOTLAND_HOLIDAYS

PUBLIC_HOLIDAYS = SCOTLAND_HOLIDAYS


def is_weekend(timestamp: pd.Timestamp) -> int:
    """Returns 1 if the timestamp falls on a weekend (Saturday or Sunday), 0 otherwise."""
    return 1 if timestamp.dayofweek >= 5 else 0


def is_public_holiday(timestamp: pd.Timestamp) -> int:
    """Returns 1 if the timestamp falls on a Scottish public holiday, 0 otherwise."""
    return 1 if timestamp.strftime("%Y-%m-%d") in PUBLIC_HOLIDAYS else 0
