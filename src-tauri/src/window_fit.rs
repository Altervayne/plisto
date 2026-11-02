/*
 * Pure geometry for keeping a floating window inside the desktop's usable area. Given a window rect
 * and the monitors' work areas, it picks the area the window belongs to and returns the top-left that
 * puts the whole window inside it. No window or monitor handles, so the rules are unit-testable.
 */

/// An axis-aligned rect in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    fn contains(&self, px: i64, py: i64) -> bool {
        px >= i64::from(self.x) && px < self.right() && py >= i64::from(self.y) && py < self.bottom()
    }

    /// The area of the overlap with `other`, zero when they do not touch.
    fn overlap(&self, other: &Rect) -> i64 {
        let w = self.right().min(other.right()) - i64::from(self.x).max(i64::from(other.x));
        let h = self.bottom().min(other.bottom()) - i64::from(self.y).max(i64::from(other.y));
        if w > 0 && h > 0 {
            w * h
        } else {
            0
        }
    }
}

/// The area a window belongs to: the one holding its centre, else the one it overlaps most. None when
/// it overlaps no area at all.
fn target_area<'a>(window: &Rect, areas: &'a [Rect]) -> Option<&'a Rect> {
    let cx = i64::from(window.x) + i64::from(window.width) / 2;
    let cy = i64::from(window.y) + i64::from(window.height) / 2;
    if let Some(area) = areas.iter().find(|a| a.contains(cx, cy)) {
        return Some(area);
    }
    areas
        .iter()
        .map(|a| (a, window.overlap(a)))
        .filter(|(_, overlap)| *overlap > 0)
        .max_by_key(|(_, overlap)| *overlap)
        .map(|(area, _)| area)
}

/// Moves `value` so a span of `extent` starting there lies inside `[start, start + len)`. A span
/// larger than the range pins to its start.
fn clamp_axis(value: i32, extent: u32, start: i32, len: u32) -> i32 {
    if extent >= len {
        return start;
    }
    let max = i64::from(start) + i64::from(len) - i64::from(extent);
    i64::from(value).clamp(i64::from(start), max) as i32
}

/// The top-left that puts the whole `window` inside the work area it belongs to, or None when it
/// overlaps no work area. A window already inside gets its own position back, so applying the result
/// again changes nothing.
pub fn fit_into_work_area(window: &Rect, areas: &[Rect]) -> Option<(i32, i32)> {
    let area = target_area(window, areas)?;
    Some((
        clamp_axis(window.x, window.width, area.x, area.width),
        clamp_axis(window.y, window.height, area.y, area.height),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: (u32, u32) = (372, 160);

    fn win(x: i32, y: i32) -> Rect {
        Rect::new(x, y, WIN.0, WIN.1)
    }

    fn main_area() -> Rect {
        Rect::new(0, 0, 1920, 1040)
    }

    #[test]
    fn a_window_already_inside_stays_put() {
        assert_eq!(fit_into_work_area(&win(100, 100), &[main_area()]), Some((100, 100)));
    }

    #[test]
    fn a_window_past_the_right_and_bottom_edges_is_pulled_back() {
        let fitted = fit_into_work_area(&win(1800, 1000), &[main_area()]);
        assert_eq!(fitted, Some((1920 - 372, 1040 - 160)));
    }

    #[test]
    fn a_window_past_the_left_and_top_edges_is_pulled_back() {
        assert_eq!(fit_into_work_area(&win(-200, -50), &[main_area()]), Some((0, 0)));
    }

    #[test]
    fn a_window_under_the_taskbar_is_lifted_into_the_work_area() {
        // The monitor is 1080 tall but the taskbar takes the bottom 40.
        let fitted = fit_into_work_area(&win(500, 1000), &[main_area()]);
        assert_eq!(fitted, Some((500, 1040 - 160)));
    }

    #[test]
    fn the_area_holding_the_centre_wins() {
        let left = Rect::new(0, 0, 1920, 1040);
        let right = Rect::new(1920, 0, 1920, 1040);
        // Straddling both monitors, centre at x = 1900 + 186 = 2086, which is on the right one.
        let fitted = fit_into_work_area(&win(1900, 800), &[left, right]);
        assert_eq!(fitted, Some((1920, 800)));
    }

    #[test]
    fn a_window_on_a_second_monitor_with_negative_origin_is_clamped_there() {
        let left = Rect::new(-1920, 0, 1920, 1040);
        let primary = main_area();
        let fitted = fit_into_work_area(&win(-2000, 100), &[primary, left]);
        assert_eq!(fitted, Some((-1920, 100)));
    }

    #[test]
    fn the_largest_overlap_wins_when_the_centre_is_off_every_area() {
        let a = Rect::new(0, 0, 1000, 1000);
        let b = Rect::new(1000, 0, 1000, 1020);
        // Centre (986, 1030) is in neither; the overlap is 200 x 50 with a and 172 x 70 with b.
        let fitted = fit_into_work_area(&win(800, 950), &[a, b]);
        assert_eq!(fitted, Some((1000, 1020 - 160)));
    }

    #[test]
    fn a_window_overlapping_nothing_has_no_target() {
        assert_eq!(fit_into_work_area(&win(5000, 5000), &[main_area()]), None);
        assert_eq!(fit_into_work_area(&win(0, 0), &[]), None);
    }

    #[test]
    fn a_window_larger_than_the_area_pins_to_its_top_left() {
        let tiny = Rect::new(10, 20, 300, 100);
        assert_eq!(fit_into_work_area(&win(50, 50), &[tiny]), Some((10, 20)));
    }

    #[test]
    fn fitting_twice_gives_the_same_position() {
        let areas = [main_area()];
        let first = fit_into_work_area(&win(1900, 1030), &areas).unwrap();
        let second = fit_into_work_area(&win(first.0, first.1), &areas).unwrap();
        assert_eq!(first, second);
    }
}
