import React from "react";
import { createRoot } from "react-dom/client";
import App from "./src/App";
import "./src/index.css";
import { RUNTIME_CONFIG } from "./src/lib/runtime-config";

// Brand comes from the brand Worker's runtime config, not from a hostname map in the bundle.
createRoot(document.getElementById("root")!).render(
  React.createElement(App, { brand: RUNTIME_CONFIG.brand })
);
