"""Small, JSON-safe display metadata for generated Earth Engine layers."""
from datetime import datetime, timezone
from math import isfinite


def layer_metadata(value):
    value = value if isinstance(value, dict) else {}
    result = {}
    for key, limit in [('source', 160), ('dataset_id', 240), ('observed_at', 100),
                       ('unit', 40), ('description', 1200)]:
        if isinstance(value.get(key), str) and value[key].strip():
            result[key] = value[key].strip()[:limit]
    result['created_at'] = datetime.now(timezone.utc).isoformat()
    return result


def legend_labels(value, visualization):
    """Labels never override the image's actual palette, range or class order."""
    if not isinstance(value, dict):
        return None
    palette = visualization.get('palette')
    labels = value.get('labels')
    if not isinstance(palette, list) or not isinstance(labels, list) or len(labels) != len(palette):
        return None
    if (value.get('type') != 'categorical' or not labels or len(labels) > 64
            or not all(isinstance(label, str) and label.strip() for label in labels)):
        return None
    minimum, maximum = visualization.get('min'), visualization.get('max')
    # GEE linearly assigns the palette over min..max. Integer, consecutive
    # classes are the supported categorical contract; other palettes stay numeric.
    if (not isinstance(minimum, (int, float)) or not isinstance(maximum, (int, float))
            or isinstance(minimum, bool) or isinstance(maximum, bool)
            or not isfinite(minimum) or not isfinite(maximum)
            or maximum - minimum != len(palette) - 1 or int(minimum) != minimum):
        return None
    return {'type': 'categorical', 'labels': [label.strip()[:100] for label in labels]}
