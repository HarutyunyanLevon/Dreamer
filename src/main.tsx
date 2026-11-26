import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/playfair-display/latin-500.css";
import "@fontsource/playfair-display/latin-600.css";
import "@fontsource/playfair-display/latin-500-italic.css";
import "@fontsource/playfair-display/latin-600-italic.css";
import "@fontsource/nunito/latin-400.css";
import "@fontsource/nunito/latin-600.css";
import "@fontsource/nunito/latin-700.css";
import "./styles/base.css";
import "./styles/panels.css";
import "./styles/cards.css";
import "./styles/dialogs.css";
import "./styles/chat.css";
import "./styles/canvas.css";
import "./styles/attachments.css";
import "./styles/kinds.css";
import "./styles/menus-frames.css";
import App from "./App";
import { bootTheme } from "./theme/ThemeContext";

bootTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
