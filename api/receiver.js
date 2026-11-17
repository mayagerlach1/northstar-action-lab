import { createNtfyLab } from "../server-lib/ntfy-lab.mjs";
import { jsonRoute } from "../server-lib/http.mjs";
export default jsonRoute(createNtfyLab().receiver);
