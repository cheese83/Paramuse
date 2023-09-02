using Paramuse.Models;

var builder = WebApplication.CreateBuilder(args);

// The server header is a useless waste of bytes, so turn it off.
builder.WebHost.UseKestrel(option => option.AddServerHeader = false);

#if !DEBUG
builder.WebHost.UseUrls($"http://*:{builder.Configuration["Port"]}");
#endif

builder.Services.AddControllersWithViews();

var basePath = builder.Configuration["BasePath"];
builder.Services.AddSingleton(sp => new AlbumList(basePath, sp.GetRequiredService<ILogger<AlbumList>>()));

// Preload the album list straight away rather than waiting for the first request from a user.
builder.Services.AddTransient<IHostedService, AlbumList.LoaderService>();

var app = builder.Build();

app.UseStaticFiles();

app.UseResponseCaching();

app.UseRouting();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
