const image = (name) => `/assets/images/${name}`;

export const helpDocuments = [
  {
    label: 'Download Case Study: Karawang (West Java), Indonesia',
    href: '/assets/docs/v1_SATGPT_QGIS_Flood_Impact_Assessment_Demo.pdf',
  },
  {
    label: 'Download User Guide',
    href: '/assets/docs/SATGPTUserGuide.pdf',
  },
];

export const helpIntro = [
  'SATGPT is an innovative solution that leverages the current capabilities of LLMs and integrates them with cloud computing platforms and Earth Observation data.',
  'SATGPT represents a fully functional, next-generation spatial decision support system designed for rapid deployment, particularly in resource-limited contexts.',
];

export const helpOverviewImage = image('guide_interface_overview.PNG');

export const helpSections = [
  {
    title: 'Option 1: Single Inundation Event',
    steps: [
      {
        text: 'Browse to https://satgpt.net/ to access the tool.',
        image: image('guide_1.PNG'),
      },
      {
        text: 'On the layer control panel select the tool of operation to map the inundation area, choosing Historical Data / Single Inundation Event.',
        image: image('guide_2.PNG'),
      },
      {
        text: 'Enter the prompt of interest specifying an incidence of flood occurrence specific to a region. Example: Tell me about floods in Thailand that occurred in 2011.',
        note: 'Tip: specify both the year and the country for faster and more accurate prompt responses.',
        image: image('guide_3.PNG'),
      },
      {
        text: 'Click the response icon to run the prompt and retrieve flood-event details.',
        image: image('guide_4.PNG'),
      },
      {
        text: 'Review the generated result with event-specific flood information.',
        image: image('guide_5.PNG'),
      },
      {
        text: 'Zoom and click a grid referenced by the result to visualize the selected area of interest on the map.',
        note: 'For example, floods in Thailand affected central and northern regions, so select a grid in those areas.',
        image: image('guide_6.PNG'),
      },
      {
        text: 'Adjust layer transparency using the options panel according to your preference.',
        image: image('guide_7.PNG'),
      },
      {
        text: 'Download GEE code to obtain a JavaScript file that can be opened locally and pasted directly into the Google Earth Engine code editor.',
        image: image('guide_8.PNG'),
      },
      {
        text: 'Enable 3D view to tilt and rotate the terrain (hold CTRL while dragging). You can also enable the buildings layer for urban-area visualization.',
        image: image('guide_9.PNG'),
      },
    ],
  },
  {
    title: 'Option 2: Alternative Historical Workflow',
    steps: [
      {
        text: 'Use the same layer control panel to continue historical event exploration.',
        image: image('guide_10.PNG'),
      },
      {
        text: 'Enter another event-specific flood prompt using the same pattern.',
        image: image('guide_11.PNG'),
      },
      {
        text: 'Run the prompt to request the flood-event summary.',
        image: image('guide_12.PNG'),
      },
      {
        text: 'Inspect the generated response and locate the grid indicated by the result.',
        image: image('guide_13.PNG'),
      },
      {
        text: 'Zoom to the relevant grid and click it to load the mapped flood layers.',
        image: image('guide_14.PNG'),
      },
      {
        text: 'Adjust transparency for the returned layers through the options panel.',
        image: image('guide_15.PNG'),
      },
      {
        text: 'Download the generated GEE JavaScript when you need to inspect or reuse the processing logic in Earth Engine.',
        image: image('guide_16.PNG'),
      },
      {
        text: 'Use 3D mode and the buildings layer to further inspect topography and urban context.',
        image: image('guide_17.PNG'),
      },
    ],
  },
];
