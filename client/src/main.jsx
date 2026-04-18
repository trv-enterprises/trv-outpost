// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@carbon/react/index.scss'
// AG Grid Community — used by dataview charts. v33+ requires explicit
// module registration; register once at app startup so every dataview
// across dashboards has the client-side row model + all community features.
// Quartz theme is AG Grid's modern flat look; we override the most
// visible vars with Carbon tokens in ./index.css so it reads as Carbon-ish.
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-quartz.css'
// Carbon g100 overrides for AG Grid — re-maps --ag-* seed colors to
// --cds-* tokens. Must come AFTER the quartz theme so the overrides win.
import './ag-grid-carbon-overrides.css'
ModuleRegistry.registerModules([AllCommunityModule])
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
