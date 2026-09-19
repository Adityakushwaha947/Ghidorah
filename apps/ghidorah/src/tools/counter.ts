import { z } from "zod";
import type { GatewayTool } from "@ghidorah/model";

export const counterTools: readonly GatewayTool[] = [
  {
    name: "fixture_increment",
    description: "Increment the isolated synthetic fixture counter once.",
    schema: z.strictObject({}),
  },
  {
    name: "fixture_read",
    description: "Read the isolated synthetic fixture counter.",
    schema: z.strictObject({}),
  },
];
