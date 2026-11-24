using Microsoft.AspNetCore.Mvc;
using Microsoft.IO;
using Microsoft.Net.Http.Headers;
using Paramuse.Models;
using SkiaSharp;
using System.Collections.Immutable;
using TagLib;

namespace Paramuse.Controllers;

public class HomeController(AlbumList albumList) : Controller
{
    private static readonly RecyclableMemoryStreamManager _memoryStreamManager = new();

    private readonly string _basePath = albumList.BasePath;
    private readonly IImmutableList<Album> _albums = albumList.Albums;

    public IActionResult Index()
    {
        var currentETag = _albums.GetHashCode().ToString();

        if (Request.Headers.TryGetValue(HeaderNames.IfNoneMatch, out var requestedETag) && requestedETag == currentETag)
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        Response.Headers.Add(HeaderNames.ETag, currentETag);

        return View(_albums);
    }

    [ResponseCache(VaryByQueryKeys = new[] { "*" }, Duration = 60 * 60 * 24 * 7)]
    public IActionResult Track(string path)
    {
        if (!_albums.SelectMany(album => album.Tracks).Any(track => track.Path == path))
        {
            return NotFound();
        }

        var mimeType = FileTypeHelpers.MimeTypeForAudioFile(path) ?? throw new ArgumentException("Unsupported file format.", nameof(path));

        // Need to set enableRangeProcessing to allow seeking to arbitrary times.
        return PhysicalFile(Path.Combine(_basePath, path), mimeType, enableRangeProcessing: true);
    }

    [ResponseCache(VaryByQueryKeys = new[] { "*" }, Duration = 60 * 60 * 24 * 7)]
    public async Task<IActionResult> Cover(string path, string size)
    {
        var maxImageBytes = 64 * 1024;
        Stream Resize(Stream inStream)
        {
            using var codec = SKCodec.Create(inStream);
            using var bitmap = SKBitmap.Decode(codec);
            var outStream = _memoryStreamManager.GetStream();

            if (size == "thumb")
            {
                var newWidth = Math.Min(bitmap.Width, 200);
                var newHeight = (int)((newWidth / (double)bitmap.Width) * bitmap.Height);
                using var resizedBitmap = bitmap.Resize(new SKSizeI(newWidth, newHeight), SKSamplingOptions.Default);
                resizedBitmap.Encode(outStream, SKEncodedImageFormat.Jpeg, 80);
            }
            else
            {
                bitmap.Encode(outStream, SKEncodedImageFormat.Jpeg, 80);
            }

            outStream.Position = 0;
            return outStream;
        }

        if (!_albums.Any(album => album.CoverPath == path || album.Tracks.Any(track => track.HasCover && track.Path == path)))
        {
            return NotFound();
        }

        var absPath = Path.Combine(_basePath, path);

        if (FileTypeHelpers.IsSupportedImageFile(path))
        {
            var fileInfo = new FileInfo(absPath);

            if (fileInfo.Length > maxImageBytes)
            {
                using var imageStream = System.IO.File.OpenRead(absPath);
                var stream = Resize(imageStream);

                return File(stream, "image/jpg");
            }
            else
            {
                var mimeType = FileTypeHelpers.MimeTypeForImageFile(path)!;

                return PhysicalFile(absPath, mimeType);
            }
        }
        else if (FileTypeHelpers.IsSupportedAudioFile(path))
        {
            var tags = TagLib.File.Create(absPath).Tag;
            var picture = tags.Pictures.Where(picture => FileTypeHelpers.IsSupportedImageMimeType(picture.MimeType))
                .OrderByDescending(picture => picture.Type == PictureType.FrontCover)
                .FirstOrDefault();

            if (picture is null)
            {
                return NotFound();
            }
            else if (picture.Data.Count > maxImageBytes)
            {
                using var imageStream = _memoryStreamManager.GetStream([.. picture.Data]);
                var stream = Resize(imageStream);

                return File(stream, "image/jpg");
            }
            else
            {
                return File([.. picture.Data], picture.MimeType);
            }
        }
        else
        {
            throw new ArgumentException("Unsupported file format.", nameof(path));
        }
    }

    [ResponseCache(VaryByQueryKeys = new[] { "*" }, Duration = 60 * 5)]
    public IActionResult Tags(string path)
    {
        if (!_albums.SelectMany(album => album.Tracks).Any(track => track.Path == path))
        {
            return NotFound();
        }

        var fi = new FileInfo(Path.Combine(_basePath, path));
        using var tagFile = TagLib.File.Create(fi.FullName);
        var model = new TagsViewModel(fi.Name, fi.Length, tagFile.Properties, tagFile.Tag);

        return PartialView(model);
    }

    public record TagsViewModel(string Name, long Length, Properties Properties, Tag Tag);
}
