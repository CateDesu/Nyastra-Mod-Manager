import { vi, type Mock } from "vitest";

export const util: {
  getGame: Mock<(gameId: string) => { executable: () => string } | undefined>;
} = { getGame: vi.fn() };
