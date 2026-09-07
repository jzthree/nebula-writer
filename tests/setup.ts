import "@testing-library/jest-dom/vitest";

const localStorageData = new Map<string, string>();

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => localStorageData.clear(),
      getItem: (key: string) => localStorageData.get(key) ?? null,
      removeItem: (key: string) => {
        localStorageData.delete(key);
      },
      setItem: (key: string, value: string) => {
        localStorageData.set(key, String(value));
      }
    }
  });
}

// Tests spawn fake CLIs constantly; keep their transcripts out of the
// developer's real ~/.nebula-writer/cli-transcripts. Individual tests that
// exercise transcript writing point this at a temp dir themselves.
process.env.WRITER_CLI_TRANSCRIPTS ??= "off";
