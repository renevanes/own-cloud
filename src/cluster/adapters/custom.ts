import type { ProviderAdapter } from "./types.js";

/** Alleen opslag: elke S3-compatibele opslag met een eigen endpoint (NAS thuis, MinIO, Garage, …). */
export const custom: ProviderAdapter = {
  id: "custom",
  name: "Eigen opslag",
  owner: "Jijzelf",
  home: "NL",
  signupUrl: "",
  keyHelp: "",
  fields: [],
  storage: {
    name: "Eigen opslag (NAS, MinIO, Garage)",
    regions: [{ id: "eigen", label: "Eigen endpoint", country: "NL", endpoint: "" }],
    customEndpoint: true,
    keyHelp: "Elke S3-compatibele opslag, bijvoorbeeld een NAS thuis. Ideaal als extra back-up op een eigen plek.",
  },
};
