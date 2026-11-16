# ICMM

ICMM (Ion Channel Model Maker) fits Markov-state kinetic models of ion channels to patch-clamp summary data. You bring your measurements as an Excel workbook (conductance–voltage, inactivation, recovery, time to peak and the like); ICMM searches many candidate state graphs with CMA-ES and ranks the models it finds by how well they predict data held back for validation.

It's a desktop app. A fit runs on your own computer, or on a SLURM cluster you reach over SSH: ICMM installs its engine in a folder you choose there, submits the jobs, and your runs keep going when you close the app.

## Install

Download the installer for your computer from the [latest release](../../releases/latest).

| System | Installer | Needs |
|---|---|---|
| Mac with Apple silicon | `…arm64…dmg` | macOS 13.3 or later |
| Mac with an Intel processor | `…x64…dmg` | macOS 13.3 or later |
| Windows | `…windows….exe` | Windows 10 22H2 or Windows 11, 64-bit |
| Linux | `…linux….deb` | Ubuntu 22.04 or later, or Debian 12 or later, 64-bit, with `libwebkit2gtk-4.1-0` 2.50 or later |

**macOS.** Open the DMG and drag ICMM into Applications. It's signed and notarized, so it opens like any other app.

**Windows.** Run the installer. It isn't signed yet, so Windows may show "Windows protected your PC": choose **More info**, then **Run anyway**. It installs for your user only and needs no administrator rights.

**Linux.** Install the package with apt, which also installs what it depends on:

```sh
sudo apt install ./icmm_*.deb
```

## Using a cluster

ICMM reaches a cluster through SSH and runs its fits as SLURM jobs. On the cluster it needs only your account and a folder on storage the compute nodes share; it brings its own Python. Add it in Settings → Compute platforms with its login host and your user name.

## Report a problem

If something goes wrong, use **Report a problem…** in Settings → General. It saves a plain-text report in your Downloads folder and opens this repository's issue form with the versions filled in. User names in the report are written `user`; keys, passwords and dataset contents are left out. Read it over, attach it and submit.

You can also [open an issue](../../issues/new/choose) yourself.

## Cite ICMM

If you use ICMM in your research, please cite it: [CITATION.cff](CITATION.cff) has the details, and GitHub's **Cite this repository** button turns them into APA or BibTeX.

## Source and license

This repository holds the source of each release, from which its installers are built. ICMM is BSD 3-Clause licensed; see [LICENSE](LICENSE).
