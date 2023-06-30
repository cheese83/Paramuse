using Microsoft.AspNetCore.Mvc;
using Microsoft.IO;
using Paramuse.Models;
using System.Collections.Immutable;
using TagLib;

namespace Paramuse.Controllers
{
    public class HomeController : Controller
    {
        private static readonly RecyclableMemoryStreamManager _memoryStreamManager = new();

        private readonly string _basePath;
        private readonly IImmutableList<Album> _albums;

        public HomeController(AlbumList albumList)
        {
            _basePath = albumList.BasePath;
            _albums = albumList.Albums;
        }

        [ResponseCache(Duration = 60 * 5)]
        public IActionResult Index()
        {
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
        public async Task<IActionResult> Cover(string path)
        {
            var maxImageBytes = 64 * 1024;
            async Task<Stream> Resize(Image image)
            {
                var newWidth = Math.Min(image.Width, 200);
                var newHeight = (int)((newWidth / (double)image.Width) * image.Height);
                image.Mutate(x => x.Resize(newWidth, newHeight));
                var stream = _memoryStreamManager.GetStream();
                await image.SaveAsJpegAsync(stream, new SixLabors.ImageSharp.Formats.Jpeg.JpegEncoder() { Quality = 80 });
                stream.Position = 0;

                return stream;
            }

            if (!_albums.Any(album => album.CoverPath == path))
            {
                return NotFound();
            }

            var absPath = Path.Combine(_basePath, path);

            if (FileTypeHelpers.IsSupportedImageFile(path))
            {
                var fileInfo = new FileInfo(absPath);

                if (fileInfo.Length > maxImageBytes)
                {
                    using Image image = await Image.LoadAsync(absPath);
                    var stream = await Resize(image);

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
                    using Image image = Image.Load(picture.Data.ToArray());
                    var stream = await Resize(image);

                    return File(stream, "image/jpg");
                }
                else
                {
                    return File(picture.Data.ToArray(), picture.MimeType);
                }
            }
            else
            {
                throw new ArgumentException("Unsupported file format.", nameof(path));
            }
        }
    }
}
