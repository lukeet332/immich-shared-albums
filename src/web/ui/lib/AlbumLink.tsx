/** web/ui/lib/AlbumLink.tsx — an album's name, opening that album in Immich. See design-system.md. */
export const AlbumLink = ({ albumId, name }: { albumId?: string; name: string }) =>
  // No id means no link, never a link to nothing: a row whose album the server could not name says
  // so by staying plain text, which is better than a target that lands somewhere arbitrary.
  albumId ? (
    <a class="isa-album-link" href={`/albums/${albumId}`}>
      {name}
    </a>
  ) : (
    <span class="isa-album-link isa-album-link--plain">{name}</span>
  );
