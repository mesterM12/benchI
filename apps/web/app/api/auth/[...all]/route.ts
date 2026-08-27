import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../lib/server";

export const { GET, POST } = toNextJsHandler(auth);
