import { ApiClient } from "@shouldertap/client";

export const api = new ApiClient({ baseUrl: import.meta.env.VITE_SERVER_URL });
