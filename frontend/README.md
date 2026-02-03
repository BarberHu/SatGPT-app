# SatGPT - React + Flask Application

This project has been restructured as a React frontend with a Flask backend API.

## Project Structure

```
SatGPT-app/
├── frontend/                 # React frontend application
│   ├── public/              # Static files
│   │   └── index.html
│   ├── src/
│   │   ├── components/      # React components
│   │   │   ├── MapContainer.js
│   │   │   ├── ControlPanel.js
│   │   │   ├── ChatBox.js
│   │   │   ├── ResultBox.js
│   │   │   ├── Legends.js
│   │   │   ├── Modals.js
│   │   │   └── Spinner.js
│   │   ├── context/         # React Context for state management
│   │   │   └── AppContext.js
│   │   ├── services/        # API service layer
│   │   │   └── api.js
│   │   ├── styles/          # CSS styles
│   │   │   └── main.css
│   │   ├── App.js
│   │   └── index.js
│   ├── package.json
│   └── .env.example
├── app.py                   # Flask backend (API server)
├── config.py                # Configuration
├── static/                  # Static assets (shared)
├── templates/               # Legacy templates (optional)
└── requirements.txt         # Python dependencies
```

## Prerequisites

- Node.js 16+ and npm
- Python 3.8+
- Google Earth Engine service account credentials
- Mapbox access token
- OpenAI API key

## Setup

### Backend (Flask)

1. Create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Create `.env` file with required environment variables:
   ```
   EE_ACCOUNT=your-ee-account@your-project.iam.gserviceaccount.com
   EE_PRIVATE_KEY_FILE=path/to/your-key.json
   GOOGLE_MAPS_API_KEY=your_google_maps_api_key
   MAPBOX_ACCESS_KEY=your_mapbox_access_key
   CHATGPT_API_KEY=your_openai_api_key
   ```

4. Start the Flask backend:
   ```bash
   python app.py
   ```
   The backend will run on http://localhost:5000

### Frontend (React)

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install npm dependencies:
   ```bash
   npm install
   ```

3. Create `.env` file from example:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and add your Mapbox access key:
   ```
   REACT_APP_MAPBOX_ACCESS_KEY=your_mapbox_access_key
   ```

5. Start the React development server:
   ```bash
   npm start
   ```
   The frontend will run on http://localhost:3000

## Development

In development mode, the React app proxies API requests to the Flask backend running on port 5000. This is configured in `frontend/package.json`:

```json
{
  "proxy": "http://localhost:5000"
}
```

### Running Both Servers

You need to run both servers simultaneously:

**Terminal 1 (Backend):**
```bash
python app.py
```

**Terminal 2 (Frontend):**
```bash
cd frontend
npm start
```

## Production Build

### Building the React App

```bash
cd frontend
npm run build
```

This creates a `build` folder with optimized static files.

### Serving in Production

For production deployment, you have several options:

1. **Serve React build from Flask**: Copy the `frontend/build` folder to `static/react` and configure Flask to serve it.

2. **Separate deployment**: Deploy the React app to a CDN or static hosting (Netlify, Vercel) and the Flask API to a server (Cloud Run, App Engine).

3. **Docker**: Create a combined Docker image that serves both.

## API Endpoints

The Flask backend provides these API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/flask-health-check` | GET | Health check |
| `/get_default` | GET | Get default water map |
| `/get_historical_map` | GET | Get historical flood data |
| `/get_flood_hotspot_map` | GET | Get flood hotspot data |
| `/get_unsupervised_map` | GET | Get unsupervised classification |
| `/chatGPT` | POST | Send message to ChatGPT |
| `/get_script` | POST | Get GEE script |
| `/get_pdf` | GET | Download PDF report |

## Features

- **Mapbox GL JS**: Interactive map with satellite imagery
- **Google Earth Engine**: Flood and water body analysis
- **ChatGPT Integration**: Natural language queries about flood events
- **Layer Controls**: Toggle and adjust transparency of multiple layers
- **3D Visualization**: Terrain and building visualization
- **GEE Code Export**: Download generated GEE code

## Component Overview

- **MapContainer**: Mapbox map with EE layers
- **ControlPanel**: Layer controls, settings, and navigation
- **ChatBox**: GPT-powered query interface
- **ResultBox**: Display query results
- **Legends**: Dynamic legend panels for active layers
- **Modals**: Welcome, help, contact, and error modals
- **Spinner**: Loading indicator

## Troubleshooting

### CORS Errors
If you encounter CORS errors, ensure:
- Flask backend has CORS enabled (already configured in `app.py`)
- React is running on http://localhost:3000
- Flask is running on http://localhost:5000

### Earth Engine Errors
- Verify your service account credentials
- Check that the EE_PRIVATE_KEY_FILE path is correct
- Ensure the service account has access to required datasets

### Mapbox Not Loading
- Verify REACT_APP_MAPBOX_ACCESS_KEY is set in `.env`
- Check that the Mapbox access token is valid
