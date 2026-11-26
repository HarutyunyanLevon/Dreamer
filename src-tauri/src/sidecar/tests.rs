use super::*;
use base64::Engine;

#[test]
fn images_are_downscaled_to_the_long_side_limit() {
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(3000, 1000).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let (mime, data) = downscale_for_claude(png.get_ref()).unwrap();
    assert_eq!(mime, "image/jpeg", "opaque images go as JPEG");
    let out = image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap();
    assert_eq!((out.width(), out.height()), (MAX_IMAGE_SIDE, 523));

    let mut small = std::io::Cursor::new(Vec::new());
    image::RgbaImage::new(40, 20).write_to(&mut small, image::ImageFormat::Png).unwrap();
    let (mime, data) = downscale_for_claude(small.get_ref()).unwrap();
    assert_eq!(mime, "image/png", "transparency keeps PNG");
    assert_eq!(image::load_from_memory(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap().width(), 40, "small images keep their size");
    assert!(downscale_for_claude(b"not an image").is_err());
}
