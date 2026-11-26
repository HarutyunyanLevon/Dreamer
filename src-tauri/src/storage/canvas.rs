//! Canvas positions and viewport.
use super::*;

impl Workspace {

    pub(super) fn read_canvas(dir: &Path) -> Result<Canvas> {
        let mut c: Canvas = read_json_or_default(&dir.join("canvas.json"))?;
        c.sanitize();
        Ok(c)
    }

    pub(super) fn write_canvas(dir: &Path, canvas: &Canvas) -> Result<()> {
        write_json(&dir.join("canvas.json"), canvas)
    }

    pub fn save_canvas(&self, slug: &str, canvas: &Canvas) -> Result<()> {
        let dir = self.existing_project_dir(slug)?;
        let mut canvas = canvas.clone();
        canvas.sanitize();
        Self::write_canvas(&dir, &canvas)
    }

    /// First free grid slot, so new cards never stack exactly on top of each other.
    pub(super) fn next_free_pos(canvas: &Canvas) -> Pos {
        for k in 0usize.. {
            let p = Pos::at((k % 4) as f64 * GRID_DX, (k / 4) as f64 * GRID_DY);
            let taken = canvas.cards.values().any(|q| (q.x - p.x).abs() < GRID_DX * 0.5 && (q.y - p.y).abs() < GRID_DY * 0.5);
            if !taken {
                return p;
            }
        }
        unreachable!()
    }
}
