# MiniMax gateway

`gateway.py` is the existing production gateway from `/opt/mmx-gw/gw.py`, now versioned here. Its authentication, quotas, audit and approval logic remain unchanged.

Context pruning applies only to messages before the latest user request. Tool results belonging to the active request remain complete, including structured content and multiple report pages. The JR control service still enforces its request-size budget and read-loop limit; the MCP catalog bounds and paginates its responses.

Run the focused regression checks without credentials or network access:

```sh
python3 services/minimax/test_context.py
```

Production binds this file into the `mmx-gw` container. Before replacing it, compare the current file with the deployed baseline, keep a backup, run Python syntax checks, restart only that container and verify its HTTP authentication response. Keep `/data` and all environment variables unchanged. No credentials or production data belong in this directory.
