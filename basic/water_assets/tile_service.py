from typing import Any, Optional


class TileProxyServer:
    """In-process tile registry served by the Basic router; opens no sockets."""
    _instance: Optional["TileProxyServer"] = None

    def __init__(self) -> None:
        self.tile_registry = {}
        self.base_url = "/api"

    @classmethod
    def get_instance(cls) -> "TileProxyServer":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register(self, layer_id: str, fetcher: Any) -> str:
        self.tile_registry[layer_id] = fetcher
        return f"{self.base_url}/ee-tiles/{layer_id}/{{z}}/{{x}}/{{y}}"
