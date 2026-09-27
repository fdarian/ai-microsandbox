# ai-microsandbox

An [AI SDK harness](https://ai-sdk.dev) sandbox provider backed by local [microsandbox](https://microsandbox.dev) microVMs. Use it when an agent needs isolated commands and files plus a forwarded port for its bridge on a host that can run microsandbox.

After the first npm release, install the package and its peers:

```sh
npm install ai-microsandbox microsandbox @ai-sdk/harness
```

The microsandbox cloud backend cannot expose the bridge port. Credentials passed to an agent can be read inside its VM, and an auto-picked host port can rarely be claimed before microsandbox binds it.

See the [package README](packages/ai-microsandbox/README.md) for a runnable example, configuration, recipes and limits.

## License

[MIT](LICENSE)
