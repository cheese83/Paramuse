﻿using System.Collections.Immutable;
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
        string AlbumArtist,
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
            AlbumArtist: tag.JoinedAlbumArtists ?? "",
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

    public sealed class AlbumList : IDisposable
    {
        private static readonly IImmutableSet<string> _coverNames = ImmutableHashSet.Create<string>("cover", "folder", "front");

        private static readonly TimeSpan _reloadDelay = TimeSpan.FromSeconds(7);
        private readonly FileSystemWatcher _watcher;
        private readonly System.Timers.Timer _reloadTimer;
        private readonly object _reloadLock = new();
        private readonly object _timerLock = new();

        public readonly string BasePath;
        public IImmutableList<Album> Albums { get; private set; }

        public AlbumList(string basePath, ILogger<AlbumList> logger)
        {
            BasePath = basePath;
            Albums = LoadAlbums(BasePath, logger);

            void restartTimer()
            {
                lock (_timerLock)
                {
                    _reloadTimer.Stop();
                    _reloadTimer.Start();
                }
            }

            _reloadTimer = new(_reloadDelay.TotalMilliseconds)
            {
                AutoReset = false
            };
            _reloadTimer.Elapsed += (sender, e) =>
            {
                if (Monitor.TryEnter(_reloadLock))
                {
                    try
                    {
                        Albums = LoadAlbums(BasePath, logger);
                    }
                    catch (Exception ex)
                    {
                        logger.LogError(ex, "Error occurred while trying to load album list. Retrying...");
                        restartTimer();
                    }
                    finally
                    {
                        Monitor.Exit(_reloadLock);
                    }
                }
                else
                {
                    // If the album list is still being loaded, go back to waiting.
                    // This will prevent too many reloads from being queued up in response to multiple file system changes over a long time period.
                    // TODO: Could use a CancellationToken to interrupt loading instead, since the result is going to be discarded shortly anyway.
                    restartTimer();
                }
            };

            _watcher = new FileSystemWatcher(BasePath)
            {
                NotifyFilter = NotifyFilters.FileName
                    | NotifyFilters.DirectoryName
                    | NotifyFilters.Size
                    // Something causes LastWrite to fire when a new file is first read, even if it's just opening the containing folder in Explorer.
                    // The other filters seem to catch every relevant file change, so just ignore LastWrite.
                    //| NotifyFilters.LastWrite
                    | NotifyFilters.CreationTime,
                IncludeSubdirectories = true,
                EnableRaisingEvents = true
                // Can't add a filter by file extension because changes may not be to a file,
                // e.g. deleting a directory triggers an event for that directory only, not to the files it contains.
            };

            void reloadAfterDelay(object sender, FileSystemEventArgs e)
            {
                logger.LogInformation("File system {ChangeType} event. Waiting for further changes...", e.ChangeType);
                restartTimer();
            }

            _watcher.Changed += reloadAfterDelay;
            _watcher.Created += reloadAfterDelay;
            _watcher.Deleted += reloadAfterDelay;
            _watcher.Renamed += reloadAfterDelay;
        }

        private static IImmutableList<Album> LoadAlbums(string basePath, ILogger<AlbumList> logger)
        {
            logger.LogInformation("Loading album list.");
            var sw = System.Diagnostics.Stopwatch.StartNew();

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
                            try
                            {
                                using var tagFile = TagLib.File.Create(file);
                                return new Track(tagFile.Tag, Path.GetRelativePath(basePath, file));
                            }
                            catch (Exception ex)
                            {
                                logger.LogWarning( "Failed to read track: {Message} {file}", ex.Message, file);
                                var blankTag = new TagLib.Id3v2.Tag();
                                return new Track(blankTag, Path.GetRelativePath(basePath, file));
                            }
                        })
                        .OrderBy(track => track.DiscNo).ThenBy(track => track.TrackNo).ThenBy(track => track.Path)
                        .ToImmutableList();
                    var coverPath = Directory.EnumerateFiles(dir, "*", new EnumerationOptions { RecurseSubdirectories = true })
                            .Where(FileTypeHelpers.IsSupportedImageFile)
                            .OrderByDescending(file => _coverNames.Count(name => Path.GetFileNameWithoutExtension(file).Contains(name, StringComparison.InvariantCultureIgnoreCase)))
                            .ThenBy(file => Path.GetDirectoryName(file)?.Length) // Prefer files in the same dir as the audio files.
                            .ThenBy(file =>
                            {
                                var match = Regex.Match(Path.GetFileNameWithoutExtension(file), "\\d+");
                                return match.Success && int.TryParse(match.Value, out var num) ? num : int.MaxValue;
                            })
                            .ThenBy(file => new FileInfo(file).Length) // Assume that smaller files are likely to be thumbnails - huge multi-MB scans are not a good choice.
                            .Select(file => Path.GetRelativePath(basePath, file))
                            .FirstOrDefault()
                        ?? tracks.FirstOrDefault(track => track.HasCover)?.Path
                        ?? "";
                    var artistTagState = tracks.Any(track => track.ArtistTagState == TagState.Missing) ? TagState.Missing :
                        tracks.Select(track => track.AlbumArtist != "" ? track.AlbumArtist : track.Artist).Distinct().Count() > 1 ? TagState.Mixed :
                        TagState.Consistent;
                    var titleTagState = tracks.Any(track => track.AlbumTagState == TagState.Missing) ? TagState.Missing :
                        tracks.Select(track => track.Album).Distinct().Count() > 1 ? TagState.Mixed :
                        TagState.Consistent;
                    var replayGainTagState = tracks.Any(track => track.ReplayGainTagState == TagState.Missing) ? TagState.Missing :
                        tracks.Select(track => track.Gain).Distinct().Count() > 1 ? TagState.Mixed :
                        TagState.Consistent;
                    var artist = artistTagState == TagState.Consistent ?
                        tracks.First().AlbumArtist != "" ? tracks.First().AlbumArtist : tracks.First().Artist :
                        Directory.GetParent(dir)?.Name ?? "?";
                    var title = titleTagState == TagState.Consistent ? tracks.First().Album : new DirectoryInfo(dir).Name;

                    return new Album(artist, title, tracks, coverPath, artistTagState, titleTagState, replayGainTagState);
                })
                .OrderBy(album => album.Artist, StringComparer.InvariantCultureIgnoreCase)
                .ThenBy(album => album.Name, StringComparer.InvariantCultureIgnoreCase)
                .ToImmutableList();

            sw.Stop();
            logger.LogInformation("Loaded album list in {TotalSeconds}s", Math.Round(sw.Elapsed.TotalSeconds, 2));

            return albums;
        }

        public void Dispose()
        {
            _watcher.Dispose();
            _reloadTimer.Dispose();
        }

        public class LoaderService : BackgroundService
        {
            private readonly IServiceProvider _services;

            public LoaderService(IServiceProvider services)
            {
                _services = services;
            }

            protected override async Task ExecuteAsync(CancellationToken stoppingToken) => await Task.Run(() =>
            {
                _services.GetRequiredService<AlbumList>();
            }, stoppingToken);
        }
    }

    public static class FileTypeHelpers
    {
        private static readonly IImmutableSet<(string extension, string mimeType)> _supportedAudioFormats = ImmutableHashSet.Create((".flac", "audio/flac"), (".mp3", "audio/mpeg"), (".ogg", "audio/ogg"), (".m4a", "audio/mp4"), (".mp4", "audio/mp4"));
        private static readonly IImmutableSet<(string extension, string mimeType)> _supportedImageFormats = ImmutableHashSet.Create((".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png"));
        // Seems to be a relatively common error.
        private static readonly IImmutableDictionary<string, string> _mimeTypeMappings = new Dictionary<string, string> { { "image/jpg", "image/jpeg" } }.ToImmutableDictionary();

        private static bool IsSupportedFile(string path, IEnumerable<(string extension, string mimeType)> formats) => formats.Any(x => x.extension.Equals(Path.GetExtension(path), StringComparison.InvariantCultureIgnoreCase));
        private static string? MimeTypeForFile(string path, IEnumerable<(string extension, string mimeType)> formats) => formats.Where(x => x.extension.Equals(Path.GetExtension(path).ToLowerInvariant(), StringComparison.InvariantCultureIgnoreCase)).Select(x => x.mimeType).SingleOrDefault();

        public static bool IsSupportedAudioFile(string path) => IsSupportedFile(path, _supportedAudioFormats);
        public static bool IsSupportedImageFile(string path) => IsSupportedFile(path, _supportedImageFormats);

        public static string? MimeTypeForAudioFile(string path) => MimeTypeForFile(path, _supportedAudioFormats);
        public static string? MimeTypeForImageFile(string path) => MimeTypeForFile(path, _supportedImageFormats);

        public static string NormalizeMimeType(string mimeType) => _mimeTypeMappings.TryGetValue(mimeType, out var mapped) ? mapped : mimeType;
        public static bool IsSupportedImageMimeType(string mimeType)
        {
            var normalizedMimeType = NormalizeMimeType(mimeType);
            return _supportedImageFormats.Any(x => x.mimeType.Equals(normalizedMimeType, StringComparison.InvariantCultureIgnoreCase));
        }
    }
}
