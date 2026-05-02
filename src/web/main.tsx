import { StrictMode } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("Root element was not found");

createRoot(root).render(createElement(StrictMode, null, createElement(App)));
