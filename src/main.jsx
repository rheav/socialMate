import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// Apply the OS theme synchronously before the first paint to avoid a light→dark
// flash; Shell's useTheme reconciles this with a stored override a tick later.
if (window.matchMedia?.("(prefers-color-scheme: dark)").matches)
  document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
