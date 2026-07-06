// Auth.js (NextAuth v5) HTTP handler for the /app user portal.
// This route is NOT covered by the /admin+/studio Basic Auth proxy matcher.
import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
