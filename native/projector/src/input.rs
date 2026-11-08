//! Streaming reader for little-endian f32 rows.

use std::io::{BufRead, ErrorKind};

use ndarray::Array2;

use crate::RunError;

pub struct RowReader<R: BufRead> {
    input: R,
    dim: usize,
    n_max: usize,
    rows_read: usize,
}

impl<R: BufRead> RowReader<R> {
    pub fn new(input: R, dim: usize, n_max: usize) -> Self {
        Self {
            input,
            dim,
            n_max,
            rows_read: 0,
        }
    }

    /// Reads up to `max_rows` rows. `Ok(None)` means EOF on a row boundary.
    pub fn next_batch(&mut self, max_rows: usize) -> Result<Option<Array2<f32>>, RunError> {
        let row_bytes = self.dim * 4;
        // Read at most one row past nMax so overflow is detected without trusting max_rows.
        let want = max_rows.min(self.n_max - self.rows_read + 1);
        let mut buf = vec![0u8; want * row_bytes];
        let got = self.fill(&mut buf)?;
        if got == 0 {
            return Ok(None);
        }
        if got % row_bytes != 0 {
            return Err(RunError::ShortRow);
        }
        let rows = got / row_bytes;
        if self.rows_read + rows > self.n_max {
            return Err(RunError::TooManyRows);
        }
        let values = self.decode(&buf[..got])?;
        self.rows_read += rows;
        Array2::from_shape_vec((rows, self.dim), values)
            .map(Some)
            .map_err(|_| RunError::ShortRow)
    }

    fn decode(&self, bytes: &[u8]) -> Result<Vec<f32>, RunError> {
        let values: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        match values.iter().position(|v| !v.is_finite()) {
            Some(at) => Err(RunError::NonFinite {
                row: self.rows_read + at / self.dim,
            }),
            None => Ok(values),
        }
    }

    fn fill(&mut self, buf: &mut [u8]) -> Result<usize, RunError> {
        let mut got = 0;
        while got < buf.len() {
            match self.input.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(got)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn bytes(vals: &[f32]) -> Vec<u8> {
        vals.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn reads_fixture_rows_in_batches() {
        let raw = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/protocol-v1/rows.3x4.f32"
        ))
        .unwrap();
        let mut r = RowReader::new(Cursor::new(raw), 4, 10);
        let first = r.next_batch(2).unwrap().unwrap();
        assert_eq!(first.dim(), (2, 4));
        assert_eq!(first[[1, 2]], -0.75);
        let second = r.next_batch(2).unwrap().unwrap();
        assert_eq!(second.dim(), (1, 4));
        assert_eq!(second[[0, 3]], -6.0);
        assert!(r.next_batch(2).unwrap().is_none());
    }

    #[test]
    fn short_row_is_an_error() {
        let mut r = RowReader::new(Cursor::new(bytes(&[1.0, 2.0, 3.0])), 2, 10);
        assert!(matches!(r.next_batch(5), Err(RunError::ShortRow)));
    }

    #[test]
    fn non_finite_reports_the_row() {
        let mut r = RowReader::new(Cursor::new(bytes(&[1.0, 2.0, 3.0, f32::INFINITY])), 2, 10);
        assert!(matches!(
            r.next_batch(5),
            Err(RunError::NonFinite { row: 1 })
        ));
    }

    #[test]
    fn more_rows_than_n_max_is_an_error() {
        let mut r = RowReader::new(Cursor::new(bytes(&[1.0; 6])), 2, 2);
        assert!(matches!(
            r.next_batch(usize::MAX),
            Err(RunError::TooManyRows)
        ));
    }
}
