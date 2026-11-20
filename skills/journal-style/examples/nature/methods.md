# Nature: published Methods paragraphs

Paragraphs from Nature research articles, reproduced under CC BY 4.0 with attribution. Citation markers are shown as [n]. Read them for rhythm, sentence shape, density and voice; never copy their wording into a new paragraph.

## Example 1

A schematic of the model is shown in Extended Data Fig. 5a. Following ref. [22], the AFM tip was modelled as a truncated cone with the half-angle θ terminated with a tangent hemispherical apex of radius R. The values of θ and R used in our simulations were measured for each AFM tip, as discussed above. The AFM cone height Hcone was limited to 6 μm and the cantilever was omitted to reduce the computational time (unless stated otherwise). We checked that these approximations had no impact on the simulated results. The simulated nanochannel consisted of two insulating slabs of hBN separated by a lossy water slab of height h and width w (measured from topography for each device). We modelled each slab explicitly with its own respective dielectric constant and conductivity according to the general definition of anisotropic, complex dielectric constant

Source: "In-plane dielectric constant and conductivity of confined water", Nature (2025), PMC12527945, CC BY 4.0.

## Example 2

To determine the taxonomic distribution of mCpol homologues, we retrieved the NCBI taxonomic identifier (taxID) associated with each protein sequence. Protein IDs were supplied to a custom script that queries the NCBI Entrez system via E-utilities (esearch, elink, efetch and xtract)[76] to extract both the taxID. For protein IDs that failed automated retrieval, taxonomic information was manually obtained using NCBI’s web interface. For each taxID, we used a separate custom Python script that calls the NCBI Datasets[77] command-line tool to obtain taxonomy summaries in JSON format and subsequently parses the taxonomic ranks saved as a tsv. A Jupyter notebook was used to further cross-referenced protein IDs with locus tag information from associated annotation files. Merging and reformatting of the dataset was performed in Python using pandas, yielding a finalized tab-delimited table containing accession IDs, taxonomic lineages and protein identifiers for downstream analysis.

Source: "A miniature CRISPR–Cas10 enzyme confers immunity by inhibitory signalling", Nature (2025), PMC12657230, CC BY 4.0.

## Example 3

We derived simple indicator-specific scenario pathways to eliminate social shortfall by 2030 and ecological overshoot by 2050 by calculating the annual linear rate of change between 2022 levels and zero for each indicator over its respective period (that is, 8 years for social indicators, 28 years for ecological indicators). We derived these simple scenario pathways to offer a rough sense of the level of ambition required to live within the Doughnut by mid-century, in comparison with the historical trends estimated empirically. Although social shortfall trends and ecological overshoot trends are both expressed in percentage points per year, we note that the values are not directly comparable across the social and ecological domains because they are scaled differently: the former are expressed in a 0–100 scale, whereas the latter are scaled with respect to pre-industrial Holocene baselines that are defined differently for different boundaries.

Source: "Doughnut of social and planetary boundaries monitors a world out of balance", Nature (2025), PMC12488500, CC BY 4.0.

## Example 4

A silicon wafer (3 × 3 mm^2, Ted Pella) was cleaned with water, acetone and isopropanol through sonication for 5 min each, followed by 60 s of O2 plasma treatment using a Harrick Plasma PDC-32 (maximum RF power of 18 W) to make the surface hydrophilic. Meanwhile, a 4 × 4-inch^2 piece of Parafilm was placed on a TechniCloth (TX609, Texwipe) with a water-filled Petri dish cover (60 × 15 mm^2, Falcon) on top. 3.5 µl of a concentrated patchy NP solution was drop-casted onto the wafer on the Parafilm. Immediately after drop-casting, both the silicon wafer and Petri dish were covered by a large Petri dish (100 × 15 mm^2, VWR) and gently pressed down to seal against the Parafilm, maintaining a humid environment (humidity: 75–80%). A typical drying process takes 16–24 h at room temperature (Supplementary Fig. 38a).

Source: "Patchy nanoparticles by atomic stencilling", Nature (2025), PMC12527929, CC BY 4.0.

## Example 5

Sequencing data were preprocessed with a custom pipeline, starting from demultiplexed but unaligned BAM files provided by the Biomedical Sequencing Facility at CeMM. BAM files were converted to FASTQ format using bedtools v.2.30.0 bamtofastq. Reads were trimmed with cutadapt v.3.4, using the -g flag to specify the 5′ adapter and stagger (Supplementary Table 1e). For the in vitro screens, raw gRNA counts were obtained with the MAGeCK package v.0.5.9.4 using the mageck count command, specifying gRNA sequences for alignment with the -l option. For in vivo CROP-seq screens, we used MAGeCK2, cloned from the GitHub repository davidliwei/mageck2 and the mageck2 count command, providing the gRNA sequences with the -l flag and defining the UMI configuration with --umi secondpair,0,26. Finally, quality-control metrics were derived from MAGeCK log files, including total reads, mapped reads, gRNA alignment rate, gRNAs with zero counts, Gini index and read-trimming statistics.

Source: "Systematic discovery of CRISPR-boosted CAR T cell immunotherapies", Nature (2025), PMC12545207, CC BY 4.0.

## Example 6

For the microscale characterization of microbubbles, the experimental set-up was built on a thin glass substrate with dimensions of 24 mm × 60 mm × 0.18 mm. As shown in Supplementary Fig. 14, a circular piezoelectric transducer (27 mm × 0.54 mm, resonance frequency 4.6 kHz ± 4%, Murata 7BB-27-4L0) was affixed to the glass substrate using an epoxy resin (2-K-Epoxidkleber, UHU Schnellfest). A square PDMS acoustic chamber (10 mm × 10 mm × 5 mm) was positioned in front of the transducer, which was filled with deionized water and covered with a cover glass (22 mm × 22 mm × 0.18 mm). An artificial muscle was suspended in the centre of the chamber with one end clamped to the side wall and the other end left free. The substrate was then mounted on an inverted microscope (Axiovert 200M, ZEISS).

Source: "Ultrasound-driven programmable artificial muscles", Nature (2025), PMC12571877, CC BY 4.0.

## Example 7

HydEn-seq and DNA libraries for sequencing were prepared as previously described[43]. In brief, WT, Yme1l^−/− and Mgme1^−/− MEF cells were mapped by HydEn-seq by hydrolysing 1 μg DNA with 0.3 M KOH for 2 h at 55 °C. Then, 1 μg of DNA was digested or left untreated with 10 U of SacI (Ymel1^−/− and its WT control) or 10 U of HincII (Mgme1^−/− and its WT control), and the digests were purified with HighPrep PCR beads (Mag-Bio) before the KOH treatment. The libraries were then purified, quantified using the Qubit fluorometric instrument (Thermo Fisher Scientific) and 75-bp-end sequenced on an Illumina NextSeq 500 instrument to identify the location of the free 5′ ends. Breakpoints arising from restriction digestion were removed during data processing. Digested and undigested samples, which showed the same trend, were analysed together as independent replicates.

Source: "Ribonucleotide incorporation into mitochondrial DNA drives inflammation", Nature (2025), PMC12629987, CC BY 4.0.

## Example 8

Most statistical tests were run in Prism 10.1.2 (GraphPad). The specific tests used are indicated in the figure legends and Supplementary Table 1. All tests were two-sided unless otherwise noted. Astrocyte Fos count analyses across groups for each brain region were run with R v.4.3.2 on RStudio v.2023.12.1.402 and relied on the tidyverse, car, dunn.test and dplyr packages and base R functions aov(), TukeyHSD() and p.adjust(). The data were first analysed with Levene’s test for homogeneity of variance. Brain regions that passed Levene’s test (P > 0.05) were followed by a one-way ANOVA test with Tukey’s honest significant difference test and regions that failed Levene’s test (P < 0.05; no homogeneity of variances) were followed by the Kruskal–Wallis test with Dunn’s post hoc test and Bonferroni adjustment. False discovery rates were calculated across groups and brain regions from post hoc P values using the Benjamini–Hochberg method.

Source: "The astrocytic ensemble acts as a multiday trace to stabilize memory", Nature (2025), PMC12675280, CC BY 4.0.

## Example 9

Written informed consent was obtained for post-mortem examination from next of kin for all patients. Clinical information and laboratory data were obtained from the electronic medical record. Sex and gender information was not used. The patients in the young group were below 40 years of age (19–37 years old). The patients in the older group were aged above 75 years (79–97 years old). Patients with skin or vascular pathologies were excluded. Skin samples were obtained from the anterolateral chest and fixed in 10% formalin for at least 24 h before processing. The slides were stained with haematoxylin and eosin, CD68 (514H12) and ERG (EPR3864). Macrophages and capillaries were identified using a combination of morphology, CD68 and ERG staining. The researcher was blinded to the age group of the samples, and counting was performed on at least eight high-power fields (×40) within 100 μm of the epidermis.

Source: "Niche-specific dermal macrophage loss promotes skin capillary ageing", Nature (2025), PMC12675291, CC BY 4.0.

## Example 10

The concentrated virus used for the subcutaneous boost was prepared by inoculating five 11-day-old embryonated chicken eggs per virus. The allantoic fluid was collected 2 d.p.i. and cleared from debris by centrifuging for 10 min at 2,100g. About 36 ml of the cleared allantoic fluid was concentrated by centrifuging for 2 h at 124,000g (SW 32 Ti, Beckman Coulter), and the resulting pellet was resuspended in 700 μl PBS. Ferrets were terminally bled through cardiac puncture 14 days after the subcutaneous boost, or 14 days after the intranasal inoculation if no boost injection was performed. Before virus inoculation, subcutaneous boost injection and the terminal bleed, ferrets were anaesthetized with ketamine and medetomidine (10 and 0.05 mg per kg body weight, respectively), the latter which was antagonized with atipamezole (0.25 mg per kg body weight).

Source: "A vaccine central in A(H5) influenza antigenic space confers broad immunity", Nature (2025), PMC12657240, CC BY 4.0.

## Example 11

The results are based on the analysis of a dataset comprising inelastic pp collisions at √s = 13 TeV, recorded with the ALICE detector[45,46] during the LHC run 2 (2015–2018). The events are selected using a high-multiplicity (HM) trigger, which captures the highest multiplicity events—specifically, the top 0.17% of all inelastic collisions that include at least one charged particle within the pseudorapidity interval |η| < 1 (denoted as 0.17% INEL > 0). This approach ensures a statistically rich sample, as a five-fold increase in the production of (anti)deuteron candidates has been observed in HM pp collisions compared with minimum bias pp collisions[47]. The sample of HM-triggered collisions considered for this analysis corresponds to 1 × 10^9 events. On average, 31 charged tracks are found within |η| < 0.5 (ref. [48]) for the HM-triggered collisions. Detailed descriptions of the event selection criteria, pileup rejection techniques, primary-vertex reconstruction methods and the HM trigger procedure are provided in ref. [49].

Source: "Observation of deuteron and antideuteron formation from resonance-decay nucleons", Nature (2025), PMC12695630, CC BY 4.0.

## Example 12

The bending durability of the MR yarn was evaluated using a continuous bending setup (Supplementary Fig. 29). A 30-cm sample was fixed at one end to a vertical glass surface. The yarn was threaded horizontally through two pairs of guide pulleys (diameter 13.76 mm) spaced 8 cm apart, followed by a single pulley (diameter 17.2 mm) mounted on a PMMA plate. A pre-tension of 32.7% of the breaking strength of the yarn was applied to the free end using a hook-weight assembly. A pair of guide pulleys (diameter 13.76 mm) was attached to a moving PMMA fixture on an Instron testing machine, programmed to cyclically bend the yarn 90° upwards and 90° downwards for around 5,000 cycles at 0.25 Hz.

Source: "Vector-stimuli-responsive magnetorheological fibrous materials", Nature (2025), PMC12611776, CC BY 4.0.
