# celiums-memory

Native Celiums Memory binary exposing MCP stdio and the authenticated native
REST/MCP server. The binary uses Hyphae `1.0.0` from the Hyphae v1.0.0 release and is the
runtime shipped inside the Cloudflare Container image.

```text
export CELIUMS_API_KEY_PEPPER=local-development-pepper-change-me
celiums-memory mcp --data <directory>
celiums-memory serve --data <directory> --api-keys <token:tenant:user:subject:role>
```
