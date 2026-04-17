function LayerLegend({ legends }: { legends: Array<{ color?: string; label: string; gradient?: boolean }> }) {
  return (
    <div className="mt-3 ml-5 space-y-1">
      {legends.map((legend, idx) => (
        <div key={idx} className="flex items-center gap-2 text-[12px] text-[#374151]">
          {legend.gradient ? (
            <div className="h-3 w-16 rounded bg-gradient-to-r from-black to-gray-300" />
          ) : (
            <div className="h-4 w-4 rounded" style={{ background: legend.color }} />
          )}
          <span>{legend.label}</span>
        </div>
      ))}
    </div>
  );
}

function RasterLayerCard({ item }: { item: { id: number; name: string; provider: string; opacity: number; visible: boolean; legends: Array<{ color?: string; label: string; gradient?: boolean }> } }) {
  return (
    <div className="rounded-lg border border-[#d8dde3] bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <input type="checkbox" defaultChecked={item.visible} className="accent-[#2563eb]" />
        <div className="truncate text-[14px] font-medium text-[#1f2937]">{item.name}</div>
      </div>
      <div className="ml-5 mt-1 text-[12px] text-gray-500">{item.provider}</div>
      <div className="ml-5 mt-2">
        <div className="h-1.5 rounded bg-gray-200">
          <div className="h-1.5 rounded bg-gray-500" style={{ width: `${item.opacity}%` }} />
        </div>
      </div>
      <LayerLegend legends={item.legends} />
    </div>
  );
}

function VectorLayerCard({ item }: { item: { id: number; name: string; source: string; type: string; visible: boolean; status: string } }) {
  return (
    <div className="rounded-lg border border-[#d8dde3] bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <input type="checkbox" defaultChecked={item.visible} className="accent-[#2563eb]" />
          <div className="truncate text-[14px] font-medium text-[#1f2937]">{item.name}</div>
        </div>
        <span className="rounded-full bg-[#eef2f7] px-2 py-0.5 text-[10px] text-[#475569]">{item.status}</span>
      </div>
      <div className="ml-5 mt-1 text-[12px] text-gray-500">{item.source} · {item.type}</div>
      <div className="ml-5 mt-2 flex flex-wrap gap-2">
        <span className="rounded-full border border-[#bfd7f6] bg-[#eaf3ff] px-2 py-0.5 text-[10px] text-[#2b5d99]">AI mentionable</span>
        <button className="rounded-full border bg-[#f8fafc] px-2 py-0.5 text-[10px] text-gray-600">Zoom to</button>
      </div>
    </div>
  );
}

function GeocodeCandidateCard({ item }: { item: { id: number; name: string; type: string } }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[#e5e7eb] bg-[#fcfcfc] px-3 py-2">
      <div>
        <div className="text-[13px] font-medium text-[#1f2937]">{item.name}</div>
        <div className="text-[11px] text-gray-500">{item.type}</div>
      </div>
      <button className="rounded border bg-white px-2 py-1 text-[11px] text-gray-600">Add</button>
    </div>
  );
}

export default function GeoAIPlatformLayout() {
  const onlineLayers = [
    {
      id: 1,
      name: "Global Flood Inundation 2024",
      type: "Raster Tile",
      provider: "GEE / XYZ",
      opacity: 85,
      visible: true,
      legends: [
        { color: "#1d4ed8", label: "Permanent Water" },
        { color: "#ef4444", label: "Inundated Area" },
      ],
    },
    {
      id: 2,
      name: "Sentinel-2 False Color",
      type: "Raster Tile",
      provider: "Tile Service",
      opacity: 70,
      visible: true,
      legends: [{ gradient: true, label: "Reflectance Stretch" }],
    },
  ];

  const vectorLayers = [
    { id: 1, name: "@研究区_洪泛平原", source: "用户上传", type: "Polygon", count: 1, visible: true, status: "Loaded" },
    { id: 2, name: "@手绘_重点分析区", source: "用户绘制", type: "Polygon", count: 1, visible: true, status: "Editing" },
    { id: 3, name: "@Nominatim_南京市玄武区", source: "区域检索", type: "Polygon", count: 1, visible: true, status: "Loaded" },
  ];

  const geocodeCandidates = [
    { id: 1, name: "Xuanwu District, Nanjing", type: "Administrative Boundary" },
    { id: 2, name: "Nanjing, Jiangsu", type: "City Boundary" },
  ];

  const chatMessages = [
    {
      role: "assistant",
      text: "You can toggle raster layers and directly read their legend under each layer. Use @ to reference vector objects.",
    },
  ];

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#9fd0e8] text-[#1f2937]">
      <div className="relative h-full w-full">
        <div className="absolute inset-0 bg-[#8ecae6]" />

        <aside className="absolute left-2 top-0 bottom-12 z-20 w-[380px] overflow-hidden rounded-b-sm border border-[#bfc2c7] bg-[#f1f1f1] shadow">
          <div className="px-4 py-3 text-[34px] font-black italic text-[#12385a]">SATGPT</div>
          <div className="mx-4 h-px bg-[#cfd2d6]" />

          <div className="h-[calc(100%-70px)] overflow-y-auto px-4 py-4">
            <div className="text-[40px] font-light">Layer Manager</div>

            <section className="mt-6">
              <div className="text-[18px] font-medium">Raster / Online Layers</div>
              <div className="mt-3 space-y-3">
                {onlineLayers.map((item) => (
                  <RasterLayerCard key={item.id} item={item} />
                ))}
              </div>
            </section>

            <section className="mt-6">
              <div>
                <div className="text-[18px] font-medium">Vector Layers</div>
                <div className="mt-1 text-[11px] text-gray-500">Uploaded, drawn, and geocoded regions are unified here.</div>
              </div>

              <div className="mt-3 rounded-lg border border-[#d8dde3] bg-white p-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 rounded border border-[#d1d5db] bg-[#fafafa] px-3 py-2 text-[13px] text-gray-500 outline-none"
                    placeholder="Search region with Nominatim..."
                  />
                  <button className="rounded bg-[#2563eb] px-3 py-2 text-[12px] font-medium text-white shadow-sm">Search</button>
                </div>
                <div className="mt-2 text-[11px] text-gray-500">Results can be added into Vector Layers and referenced in AI chat with @.</div>
              </div>

              <div className="mt-3 rounded-lg border border-[#d8dde3] bg-white p-3 shadow-sm">
                <div className="text-[13px] font-medium text-gray-700">Geocode Candidates</div>
                <div className="mt-2 space-y-2">
                  {geocodeCandidates.map((item) => (
                    <GeocodeCandidateCard key={item.id} item={item} />
                  ))}
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {vectorLayers.map((item) => (
                  <VectorLayerCard key={item.id} item={item} />
                ))}
              </div>
            </section>
          </div>
        </aside>

        <div className="absolute right-[372px] top-4 z-20 flex flex-col overflow-hidden rounded-md border border-[#cfd2d6] bg-white shadow">
          <button className="flex h-10 w-10 items-center justify-center border-b text-[#374151] hover:bg-gray-50" title="Zoom in">+</button>
          <button className="flex h-10 w-10 items-center justify-center border-b text-[#374151] hover:bg-gray-50" title="Zoom out">−</button>
          <button className="flex h-10 w-10 items-center justify-center border-b text-[#374151] hover:bg-gray-50" title="Reset north">⟳</button>
          <button className="flex h-10 w-10 items-center justify-center border-b text-[#374151] hover:bg-gray-50" title="Locate me">⌖</button>
          <button className="flex h-10 w-10 items-center justify-center border-b text-[#374151] hover:bg-gray-50" title="Draw polygon">⬠</button>
          <button className="flex h-10 w-10 items-center justify-center border-b text-[#374151] hover:bg-gray-50" title="Delete drawing">⌫</button>
          <button className="flex h-10 w-10 items-center justify-center text-[#374151] hover:bg-gray-50" title="Fullscreen">⤢</button>
        </div>

        <aside className="absolute right-0 top-0 bottom-0 z-30 flex w-[360px] flex-col border-l bg-[#f2f2f2]">
          <div className="border-b p-4 text-[22px] font-light">AI Analysis</div>

          <div className="flex-1 space-y-3 overflow-auto p-4">
            {chatMessages.map((msg, i) => (
              <div key={i} className="rounded border bg-white p-3 text-sm shadow-sm">
                {msg.text}
              </div>
            ))}
          </div>

          <div className="border-t p-4">
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded border bg-white px-3 py-3 text-sm text-gray-500 outline-none"
                placeholder="Type with @ to select vector layer..."
              />
              <button className="flex h-10 w-10 items-center justify-center rounded border bg-white text-lg text-[#4b5563] shadow-sm" title="Upload vector">
                📎
              </button>
              <button className="flex h-10 w-10 items-center justify-center rounded bg-[#2563eb] text-lg text-white shadow" title="Send message">
                ➤
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
