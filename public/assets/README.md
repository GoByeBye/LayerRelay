# Custom overlay assets

Files in this directory are served at `/assets/<name>` and can be selected with
`overlayHost.icon` in `config.json`.

Custom assets are ignored by Git by default because they may be personal or have
redistribution restrictions. If you intentionally want to distribute an asset,
add it explicitly and document its source and license.

Docker Compose bind-mounts this directory read-only into the runtime container,
so local ignored assets remain usable without being baked into the image. A
direct `docker run` deployment must provide the equivalent read-only mount:

```sh
--mount type=bind,src=/absolute/path/to/public/assets,dst=/app/public/assets,readonly
```
