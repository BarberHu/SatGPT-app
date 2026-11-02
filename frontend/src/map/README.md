# Shared map workspace

`ModeRoot` keeps `AppProvider` and `SharedMapProvider` mounted for the workspace lifetime. The Basic panel stays mounted; the Agent panel mounts on its first visit and then retains its chat, input, history and SSE state. Only the business panels and layer groups are switched.

`SharedMapSurface` owns the stable canvas container. `SharedMapViewport` describes its visible rectangle without moving or remounting the canvas. A single layout observer follows sidebars, resizable panels and narrow-screen tabs. `MapScale`, navigation, snapshots, English basemap labels, load/error state and persisted camera belong to the shared workspace.

`MapService` is the engine-neutral application port. Agent result groups are keyed by conversation (`agent:<conversation-id>`), with namespaced engine IDs. Layer visibility is a user preference; group visibility is applied separately. History changes can restore a result extent only through a captured view intent. Mode changes and arriving results never request camera movement. View intents expire after a mode change, a different conversation, or user camera movement.

`MapboxAdapter` is the only engine creator/disposer. `BasicMapPort` is a deliberately Mapbox-specific extension boundary for the existing draw, grid, terrain and raster algorithms in `basic/BasicMapController`. It gives those algorithms scoped IDs (`satgpt-basic:*`, `satgpt-basic-aux:*`), logical visibility, guarded map/DOM listeners and suspended controls. The compatibility `AppContext.mapInstance` contains this scoped port, not the native map. New business components should use the application port instead of extending native-map dependencies.

The saved shared camera (`satgpt:map-view:v1`) includes center, zoom, bearing and pitch. The previous Agent camera key is read as a compatibility fallback without clearing storage. Agent layer preferences retain their existing per-conversation keys and logical result IDs. SSE remains subscribed once after the Agent panel's first mount, including while Static layers is active, and is cleaned up when the workspace unmounts.
