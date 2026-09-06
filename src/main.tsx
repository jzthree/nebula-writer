import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { captureShareTokenFromLocation } from "./shareToken";
import "./styles.css";

// Pull the share-link access token out of the URL fragment before anything
// connects to the sidecar, then scrub it from the address bar.
captureShareTokenFromLocation();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
