# ai-microsandbox

`HarnessV1SandboxProvider` implementation for [microsandbox](https://microsandbox.dev), a local-first microVM sandbox runtime, for use with [AI SDK](https://ai-sdk.dev) harnesses.

## Install

```bash
npm i ai-microsandbox microsandbox @ai-sdk/harness
```

## Usage

```ts
import { createMicrosandbox } from 'ai-microsandbox';

const provider = createMicrosandbox({ image: 'alpine' });

const networkSession = await provider.createSession();
const session = networkSession.restricted();

await session.writeTextFile({ path: 'hello.txt', content: 'hi' });
const { stdout } = await session.run({ command: 'cat hello.txt' });
console.log(stdout); // "hi"

await networkSession.stop();
```

See [`packages/ai-microsandbox`](packages/ai-microsandbox) for setup requirements, configuration, and the full guide.

## License

[MIT](LICENSE)
