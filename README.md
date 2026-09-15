This was an attempt to make a plugin to sync my obsidian notes with a WebDAV server.
I made it time ago and I'm not sure if stills working in latest versions of obsidian
since I'm no longer using it.

>[!NOTE]
> This is a bit expensive on lower-end devices since all of the walks are made into memory.
> I tried it on my old phone and obsidian was crashing when doing a sync, I guess it becomes worse with larger filesystems/lots of notes.

To use this just clone the repository, install the dependencies and build.

```
npm install
npm run build
```

And then copy `main.js`, `styles.css` and `manifest.json` to your obsidian plugin folder..
