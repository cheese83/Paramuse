using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TagLib;

namespace Paramuse.Models
{
    public enum TagState
    {
        Missing,
        Mixed, // e.g. compilation where tracks may all have different artists.
        Consistent
    }

    public record Album
    (
        string Artist,
        string Name,
        IImmutableList<Track> Tracks,
        string CoverPath,
        TagState ArtistTagState,
        TagState NameTagState,
        TagState ReplayGainTagState
    );

    public record Track
    (
        string Artist,
        string Album,
        string Title,
        int TrackNo,
        int DiscNo,
        double Gain,
        double Peak,
        bool HasCover,
        TagState ArtistTagState,
        TagState AlbumTagState,
        TagState TitleTagState,
        TagState TrackNoTagState,
        TagState ReplayGainTagState,
        string Path
    )
    {
        public Track(Tag tag, string path) : this
        (
            Artist: tag.JoinedPerformers ?? tag.JoinedAlbumArtists ?? "?",
            Album: tag.Album ?? "?",
            Title: tag.Title ?? System.IO.Path.GetFileName(path),
            TrackNo: (int)tag.Track,
            DiscNo: (int)tag.Disc,
            Gain: !double.IsNaN(tag.ReplayGainAlbumGain) ? tag.ReplayGainAlbumGain
                : !double.IsNaN(tag.ReplayGainTrackGain) ? tag.ReplayGainTrackGain
                : 0,
            Peak: !double.IsNaN(tag.ReplayGainAlbumPeak) ? tag.ReplayGainAlbumPeak
                : !double.IsNaN(tag.ReplayGainTrackPeak) ? tag.ReplayGainTrackPeak
                : 1,
            // Assume that if there are any pictures at all, one of them is suitable for use as a cover.
            HasCover: tag.Pictures.Any(picture => FileTypeHelpers.IsSupportedImageMimeType(picture.MimeType)),
            ArtistTagState: string.IsNullOrWhiteSpace(tag.JoinedPerformers ?? tag.JoinedAlbumArtists) ? TagState.Missing : TagState.Consistent,
            AlbumTagState: string.IsNullOrWhiteSpace(tag.Album) ? TagState.Missing : TagState.Consistent,
            TitleTagState: string.IsNullOrWhiteSpace(tag.Title) ? TagState.Missing : TagState.Consistent,
            TrackNoTagState: tag.Track == 0 ? TagState.Missing : TagState.Consistent,
            ReplayGainTagState: double.IsNaN(tag.ReplayGainAlbumGain) && double.IsNaN(tag.ReplayGainTrackGain) ? TagState.Missing : TagState.Consistent,
            Path: path
        )
        { }
    }

    public class AlbumList
    {
        private readonly IImmutableSet<string> _coverNames = ImmutableHashSet.Create<string>("cover", "folder", "front");

        public readonly string BasePath;
        public readonly IImmutableList<Album> Albums;

        public AlbumList(string basePath)
        {
            var dirs = Directory.EnumerateDirectories(basePath, "*", new EnumerationOptions { RecurseSubdirectories = true });
            var albumDirs = dirs
                .Where(dir => Directory.EnumerateFiles(dir).Any(FileTypeHelpers.IsSupportedAudioFile))
                .ToImmutableHashSet();
            var albums = albumDirs
                .Select(dir =>
                {
                    var tracks = Directory.EnumerateFiles(dir, "*.*").Where(FileTypeHelpers.IsSupportedAudioFile)
                        .Select(file =>
                        {
                            using var tagFile = TagLib.File.Create(file);
                            return new Track(tagFile.Tag, Path.GetRelativePath(basePath, file));
                        })
                        .OrderBy(track => track.DiscNo).ThenBy(track => track.TrackNo).ThenBy(track => track.Path)
                        .ToImmutableList();
                    var coverPath = tracks.FirstOrDefault(track => track.HasCover)?.Path
                        ?? Directory.EnumerateFiles(dir, "*", new EnumerationOptions { RecurseSubdirectories = true })
                            .Where(FileTypeHelpers.IsSupportedImageFile)
                            .OrderByDescending(file => _coverNames.Any(name => Path.GetFileNameWithoutExtension(file).Contains(name, StringComparison.InvariantCultureIgnoreCase)))
                            .ThenBy(file =>
                            {
                                var match = Regex.Match(Path.GetFileNameWithoutExtension(file), "\\d+");
                                return match.Success && int.TryParse(match.Value, out var num) ? num : int.MaxValue;
                            })
                            .ThenBy(file => new FileInfo(file).Length) // Assume that smaller files are likely to be thumbnails - huge multi-MB scans are not a good choice.
                            .Select(file => Path.GetRelativePath(basePath, file))
                            .FirstOrDefault() ?? "";
                    var artistTagState = tracks.Any(track => track.ArtistTagState == TagState.Missing) ? TagState.Missing :
                        tracks.Select(track => track.Artist).Distinct().Count() > 1 ? TagState.Mixed :
                        TagState.Consistent;
                    var titleTagState = tracks.Any(track => track.TitleTagState == TagState.Missing) ? TagState.Missing :
                        tracks.Select(track => track.Album).Distinct().Count() > 1 ? TagState.Mixed :
                        TagState.Consistent;
                    var replayGainTagState = tracks.Any(track => track.ReplayGainTagState == TagState.Missing) ? TagState.Missing :
                        tracks.Select(track => track.Gain).Distinct().Count() > 1 ? TagState.Mixed :
                        TagState.Consistent;
                    var artist = artistTagState == TagState.Consistent ? tracks.First().Artist : Directory.GetParent(dir)?.Name ?? "?";
                    var title = titleTagState == TagState.Consistent ? tracks.First().Album : new DirectoryInfo(dir).Name;

                    return new Album(artist, title, tracks, coverPath, artistTagState, titleTagState, replayGainTagState);
                })
                .OrderBy(album => album.Artist).ThenBy(album => album.Name)
                .ToImmutableList();

            BasePath = basePath;
            Albums = albums;
        }

        public class LoaderService : BackgroundService
        {
            private readonly IServiceProvider _services;
            private readonly ILogger<LoaderService> _logger;

            public LoaderService(IServiceProvider services, ILogger<LoaderService> logger)
            {
                _services = services;
                _logger = logger;
            }

            protected override async Task ExecuteAsync(CancellationToken stoppingToken) =>  await Task.Run(() =>
            {
                _logger.LogInformation("Loading album list.");
                var sw = System.Diagnostics.Stopwatch.StartNew();
                _services.GetRequiredService<AlbumList>();
                sw.Stop();
                _logger.LogInformation("Loaded album list in {TotalSeconds}s", Math.Round(sw.Elapsed.TotalSeconds, 2));
            }, stoppingToken);
        }
    }

    public static class FileTypeHelpers
    {
        private static readonly IImmutableSet<(string extension, string mimeType)> _supportedAudioFormats = ImmutableHashSet.Create((".flac", "audio/flac"), (".mp3", "audio/mpeg"), (".ogg", "audio/ogg"));
        private static readonly IImmutableSet<(string extension, string mimeType)> _supportedImageFormats = ImmutableHashSet.Create((".jpg", "image/jpg"), (".jpeg", "image/jpg"), (".png", "image/png"));

        private static bool IsSupportedFile(string path, IEnumerable<(string extension, string mimeType)> formats) => formats.Any(x => x.extension.Equals(Path.GetExtension(path), StringComparison.InvariantCultureIgnoreCase));
        private static string? MimeTypeForFile(string path, IEnumerable<(string extension, string mimeType)> formats) => formats.Where(x => x.extension.Equals(Path.GetExtension(path).ToLowerInvariant(), StringComparison.InvariantCultureIgnoreCase)).Select(x => x.mimeType).SingleOrDefault();

        public static bool IsSupportedAudioFile(string path) => IsSupportedFile(path, _supportedAudioFormats);
        public static bool IsSupportedImageFile(string path) => IsSupportedFile(path, _supportedImageFormats);

        public static string? MimeTypeForAudioFile(string path) => MimeTypeForFile(path, _supportedAudioFormats);
        public static string? MimeTypeForImageFile(string path) => MimeTypeForFile(path, _supportedImageFormats);

        public static bool IsSupportedImageMimeType(string mimeType) => _supportedImageFormats.Any(x => x.mimeType.Equals(mimeType, StringComparison.InvariantCultureIgnoreCase));
    }
}
